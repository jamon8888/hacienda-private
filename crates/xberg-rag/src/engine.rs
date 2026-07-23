use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use crate::{
    Embedder, FlatStore, IndexedChunk, MatterPaths, RagError, Result, RetrievedChunk, SearchStore,
    legacy::read_bundle_chunks,
};

/// One chunk offered for indexing.
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkInput {
    pub text: String,
    pub page: Option<u32>,
}

/// One document's chunks, indexed under `doc_id`.
#[derive(Debug, Clone, PartialEq)]
pub struct DocumentInput {
    pub doc_id: String,
    pub chunks: Vec<ChunkInput>,
}

/// Owns the on-disk RAG index for a set of matters and answers live queries
/// against it. Generic over the embedding backend so the same engine runs with a
/// real model (native host) or [`crate::MockEmbedder`] (tests).
///
/// Stateless between calls: every query re-reads the matter's snapshot from disk.
pub struct RagEngine<E: Embedder> {
    embedder: E,
    mirrors_dir: PathBuf,
}

struct MatterWriteLock {
    _file: File,
}

impl<E: Embedder> RagEngine<E> {
    /// Build an engine writing under `mirrors_dir` (see [`crate::default_mirrors_dir`]).
    pub fn new(embedder: E, mirrors_dir: PathBuf) -> Self {
        Self { embedder, mirrors_dir }
    }

    /// The mirrors root this engine reads and writes.
    pub fn mirrors_dir(&self) -> &Path {
        &self.mirrors_dir
    }

    fn paths(&self, matter_id: &str) -> Result<MatterPaths> {
        MatterPaths::new(&self.mirrors_dir, matter_id)
    }

    /// Load a matter's store, or an empty one when it has no snapshot yet.
    fn load_or_empty(&self, paths: &MatterPaths) -> Result<FlatStore> {
        let path = paths.snapshot();
        if !path.exists() {
            return Ok(FlatStore::with_identity(self.embedder.identity().clone()));
        }
        let bytes = std::fs::read(&path).map_err(|e| RagError::Io(format!("read {}: {e}", path.display())))?;
        let store = FlatStore::load(&bytes)?;
        if store.identity() != self.embedder.identity() {
            return Err(RagError::EmbeddingIdentityMismatch {
                snapshot: Box::new(store.identity().clone()),
                embedder: Box::new(self.embedder.identity().clone()),
            });
        }
        Ok(store)
    }

    fn acquire_write_lock(&self, paths: &MatterPaths) -> Result<MatterWriteLock> {
        std::fs::create_dir_all(&paths.dir)
            .map_err(|e| RagError::Io(format!("create {}: {e}", paths.dir.display())))?;
        let lock_path = paths.write_lock();
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|e| RagError::Io(format!("open lock {}: {e}", lock_path.display())))?;
        file.lock()
            .map_err(|e| RagError::Io(format!("lock {}: {e}", lock_path.display())))?;
        Ok(MatterWriteLock { _file: file })
    }

    /// Write a store's snapshot atomically: stage to a sibling temp file, then
    /// rename over the target. A crash never leaves a torn snapshot — the same
    /// guarantee the Node host gives for its mirror directory.
    fn save(&self, paths: &MatterPaths, store: &FlatStore) -> Result<()> {
        std::fs::create_dir_all(&paths.dir)
            .map_err(|e| RagError::Io(format!("create {}: {e}", paths.dir.display())))?;
        let final_path = paths.snapshot();
        let bytes = store.snapshot()?;
        let mut staged = tempfile::Builder::new()
            .prefix("rag.snapshot.")
            .suffix(".tmp")
            .tempfile_in(&paths.dir)
            .map_err(|e| RagError::Io(format!("create temporary snapshot in {}: {e}", paths.dir.display())))?;
        staged
            .write_all(&bytes)
            .map_err(|e| RagError::Io(format!("write temporary snapshot in {}: {e}", paths.dir.display())))?;
        staged
            .persist(&final_path)
            .map_err(|e| RagError::Io(format!("persist snapshot as {}: {}", final_path.display(), e.error)))?;
        Ok(())
    }

    /// Embed and index `docs` into `matter_id`, adding to whatever is already
    /// indexed. Returns the matter's total chunk count after the write.
    pub fn index_documents(&self, matter_id: &str, docs: &[DocumentInput]) -> Result<usize> {
        let paths = self.paths(matter_id)?;
        let mut texts: Vec<String> = Vec::new();
        let mut meta: Vec<(String, u32, Option<u32>)> = Vec::new();
        for doc in docs {
            for (i, chunk) in doc.chunks.iter().enumerate() {
                texts.push(chunk.text.clone());
                meta.push((doc.doc_id.clone(), i as u32, chunk.page));
            }
        }
        if texts.is_empty() {
            return Ok(self.load_or_empty(&paths)?.len());
        }

        let vectors = self.embedder.embed_documents(&texts)?;
        if vectors.len() != texts.len() {
            return Err(RagError::Embed(format!(
                "embedder returned {} vectors for {} texts",
                vectors.len(),
                texts.len()
            )));
        }

        let items: Vec<IndexedChunk> = meta
            .into_iter()
            .zip(texts)
            .zip(vectors)
            .map(|(((doc_id, chunk_index, page), text), vector)| IndexedChunk {
                citation: Some(format!("{doc_id}:{chunk_index}")),
                doc_id,
                chunk_index,
                text,
                page,
                vector,
            })
            .collect();

        // Serialize the complete read-modify-write transaction. Locking only
        // `save` still allows two writers to read the same old snapshot and
        // overwrite one another's additions.
        let _write_lock = self.acquire_write_lock(&paths)?;
        let mut store = self.load_or_empty(&paths)?;
        store.ingest(&items)?;
        self.save(&paths, &store)?;
        Ok(store.len())
    }

    /// Live search: embed `text` and search the matter's actual vectors.
    ///
    /// This is the behaviour the Node host could not provide — its
    /// `MirrorStore.retrieve()` ignored the query and re-sorted mirrored chunks
    /// by a mirror-time placeholder score.
    pub fn query(&self, matter_id: &str, text: &str, top_k: usize) -> Result<Vec<RetrievedChunk>> {
        let paths = self.paths(matter_id)?;
        let path = paths.snapshot();
        if !path.exists() {
            return Err(RagError::MatterNotFound(matter_id.to_string()));
        }
        let store = self.load_or_empty(&paths)?;
        let q = self.embedder.embed_query(text)?;
        store.search(&q, top_k)
    }

    /// Rebuild a matter's snapshot from a legacy JSON `MirrorBundle` by
    /// re-embedding its chunk texts. Replaces any existing snapshot unless the
    /// bundle is empty, in which case it is a no-op that leaves any existing
    /// snapshot untouched; returns the number of chunks imported.
    pub fn import_legacy(&self, matter_id: &str) -> Result<usize> {
        let paths = self.paths(matter_id)?;
        let _write_lock = self.acquire_write_lock(&paths)?;
        let path = paths.legacy_bundle();
        if !path.exists() {
            return Err(RagError::MatterNotFound(matter_id.to_string()));
        }
        let json = std::fs::read(&path).map_err(|e| RagError::Io(format!("read {}: {e}", path.display())))?;
        let legacy = read_bundle_chunks(&json)?;
        if legacy.is_empty() {
            return Ok(0);
        }

        let texts: Vec<String> = legacy.iter().map(|c| c.text.clone()).collect();
        let vectors = self.embedder.embed_documents(&texts)?;
        if vectors.len() != texts.len() {
            return Err(RagError::Embed(format!(
                "embedder returned {} vectors for {} texts",
                vectors.len(),
                texts.len()
            )));
        }

        let items: Vec<IndexedChunk> = legacy
            .into_iter()
            .zip(vectors)
            .map(|(c, vector)| IndexedChunk {
                doc_id: c.doc_id,
                chunk_index: c.chunk_index,
                text: c.text,
                page: c.page,
                citation: c.citation,
                vector,
            })
            .collect();

        let mut store = FlatStore::with_identity(self.embedder.identity().clone());
        store.ingest(&items)?;
        let count = store.len();
        self.save(&paths, &store)?;
        Ok(count)
    }
}

#[cfg(all(test, feature = "testing"))]
mod tests {
    use super::*;
    use crate::MockEmbedder;
    use std::sync::{Arc, Barrier};

    fn engine(dir: &Path) -> RagEngine<MockEmbedder> {
        RagEngine::new(MockEmbedder::new(16), dir.to_path_buf())
    }

    fn doc(id: &str, texts: &[&str]) -> DocumentInput {
        DocumentInput {
            doc_id: id.to_string(),
            chunks: texts
                .iter()
                .map(|t| ChunkInput {
                    text: (*t).to_string(),
                    page: None,
                })
                .collect(),
        }
    }

    #[test]
    fn query_returns_the_chunk_matching_the_query_text() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        e.index_documents("m1", &[doc("d1", &["alpha content", "beta content", "gamma content"])])
            .unwrap();

        // MockEmbedder is deterministic, so embedding the exact chunk text yields
        // that chunk's own vector — cosine 1.0, and it must rank first.
        let hits = e.query("m1", "beta content", 3).unwrap();
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].text, "beta content");
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn query_result_depends_on_the_query() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        e.index_documents("m1", &[doc("d1", &["alpha content", "beta content"])])
            .unwrap();

        let a = e.query("m1", "alpha content", 1).unwrap();
        let b = e.query("m1", "beta content", 1).unwrap();
        // The regression this whole phase exists to prevent: a retrieve() that
        // ignores the query would return the same chunk for both.
        assert_ne!(a[0].text, b[0].text);
    }

    #[test]
    fn indexing_is_additive_across_calls() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        assert_eq!(e.index_documents("m1", &[doc("d1", &["one"])]).unwrap(), 1);
        assert_eq!(e.index_documents("m1", &[doc("d2", &["two", "three"])]).unwrap(), 3);
        assert_eq!(e.query("m1", "two", 10).unwrap().len(), 3);
    }

    #[derive(Clone)]
    struct SynchronizedEmbedder {
        inner: MockEmbedder,
        barrier: Arc<Barrier>,
    }

    impl Embedder for SynchronizedEmbedder {
        fn identity(&self) -> &crate::EmbeddingIdentity {
            self.inner.identity()
        }

        fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
            let vectors = self.inner.embed_documents(texts)?;
            // Align all writers immediately before they enter the protected
            // read-modify-write section, maximizing contention deterministically.
            self.barrier.wait();
            Ok(vectors)
        }

        fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
            self.inner.embed_query(text)
        }
    }

    #[test]
    fn concurrent_indexing_preserves_every_writers_chunks() {
        const WRITER_COUNT: usize = 12;

        let tmp = tempfile::tempdir().unwrap();
        let mirrors_dir = tmp.path().to_path_buf();
        let barrier = Arc::new(Barrier::new(WRITER_COUNT));
        let handles: Vec<_> = (0..WRITER_COUNT)
            .map(|writer| {
                let embedder = SynchronizedEmbedder {
                    inner: MockEmbedder::new(16),
                    barrier: Arc::clone(&barrier),
                };
                let engine = RagEngine::new(embedder, mirrors_dir.clone());
                std::thread::spawn(move || {
                    let document = doc(&format!("doc-{writer}"), &[&format!("text-{writer}")]);
                    engine.index_documents("shared", &[document])
                })
            })
            .collect();

        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let hits = engine(&mirrors_dir).query("shared", "text", WRITER_COUNT).unwrap();
        assert_eq!(hits.len(), WRITER_COUNT);
    }

    #[test]
    fn index_sets_citation_from_doc_and_chunk_index() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        e.index_documents("m1", &[doc("d1", &["only"])]).unwrap();
        let hits = e.query("m1", "only", 1).unwrap();
        assert_eq!(hits[0].citation.as_deref(), Some("d1:0"));
        assert_eq!(hits[0].chunk_index, 0);
    }

    #[test]
    fn query_on_unknown_matter_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        assert!(matches!(
            e.query("nope", "anything", 3).unwrap_err(),
            RagError::MatterNotFound(_)
        ));
    }

    #[test]
    fn import_legacy_rebuilds_a_searchable_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        let paths = MatterPaths::new(tmp.path(), "m1").unwrap();
        std::fs::create_dir_all(&paths.dir).unwrap();
        std::fs::write(
            paths.legacy_bundle(),
            r#"{"version":1,"index":[],"vault":[],"pii":[],"chunks":[
                {"doc_id":"d1","chunk_index":0,"text":"legacy alpha","score":0.1,"citation":"d1:0"},
                {"doc_id":"d1","chunk_index":1,"text":"legacy beta","score":0.2,"citation":"d1:1"}
            ]}"#,
        )
        .unwrap();

        assert_eq!(e.import_legacy("m1").unwrap(), 2);
        let hits = e.query("m1", "legacy beta", 2).unwrap();
        assert_eq!(hits[0].text, "legacy beta");
        assert_eq!(hits[0].citation.as_deref(), Some("d1:1"));
    }

    #[test]
    fn empty_legacy_import_preserves_existing_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        e.index_documents("m1", &[doc("current", &["preserve me"])]).unwrap();
        let paths = MatterPaths::new(tmp.path(), "m1").unwrap();
        let before = std::fs::read(paths.snapshot()).unwrap();
        std::fs::write(
            paths.legacy_bundle(),
            r#"{"version":1,"index":[],"vault":[],"pii":[],"chunks":[]}"#,
        )
        .unwrap();

        assert_eq!(e.import_legacy("m1").unwrap(), 0);
        assert_eq!(std::fs::read(paths.snapshot()).unwrap(), before);
        assert_eq!(e.query("m1", "preserve me", 1).unwrap()[0].text, "preserve me");
    }

    #[test]
    fn import_legacy_on_missing_bundle_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        assert!(matches!(
            e.import_legacy("m1").unwrap_err(),
            RagError::MatterNotFound(_)
        ));
    }

    #[test]
    fn snapshot_survives_a_fresh_engine_instance() {
        let tmp = tempfile::tempdir().unwrap();
        engine(tmp.path())
            .index_documents("m1", &[doc("d1", &["persisted text"])])
            .unwrap();
        // A brand-new engine (as a fresh MCP process would build) sees the data.
        let hits = engine(tmp.path()).query("m1", "persisted text", 1).unwrap();
        assert_eq!(hits[0].text, "persisted text");
    }

    /// Returns fewer vectors than it was given texts — the failure mode that
    /// `zip` would otherwise swallow as silent data loss.
    struct ShortEmbedder {
        identity: crate::EmbeddingIdentity,
    }

    impl Embedder for ShortEmbedder {
        fn identity(&self) -> &crate::EmbeddingIdentity {
            &self.identity
        }
        fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
            // One fewer vector than requested.
            Ok(texts.iter().skip(1).map(|_| vec![0.0; 4]).collect())
        }
        fn embed_query(&self, _text: &str) -> Result<Vec<f32>> {
            Ok(vec![0.0; 4])
        }
    }

    #[test]
    fn import_legacy_rejects_an_embedder_that_returns_too_few_vectors() {
        let tmp = tempfile::tempdir().unwrap();
        let e = RagEngine::new(
            ShortEmbedder {
                identity: MockEmbedder::new(4).identity().clone(),
            },
            tmp.path().to_path_buf(),
        );
        let paths = MatterPaths::new(tmp.path(), "m1").unwrap();
        std::fs::create_dir_all(&paths.dir).unwrap();
        std::fs::write(
            paths.legacy_bundle(),
            r#"{"version":1,"index":[],"vault":[],"pii":[],"chunks":[
                {"doc_id":"d1","chunk_index":0,"text":"alpha","score":0.1,"citation":"d1:0"},
                {"doc_id":"d1","chunk_index":1,"text":"beta","score":0.2,"citation":"d1:1"}
            ]}"#,
        )
        .unwrap();

        // Must error, not silently import only one of the two chunks.
        assert!(matches!(e.import_legacy("m1").unwrap_err(), RagError::Embed(_)));
    }

    #[test]
    fn same_dimension_different_embedding_identity_cannot_query_or_append() {
        let tmp = tempfile::tempdir().unwrap();
        let first = RagEngine::new(MockEmbedder::with_artifact(16, "artifact-a"), tmp.path().to_path_buf());
        first.index_documents("m1", &[doc("d1", &["original"])]).unwrap();

        let incompatible = RagEngine::new(MockEmbedder::with_artifact(16, "artifact-b"), tmp.path().to_path_buf());
        assert!(matches!(
            incompatible.query("m1", "original", 1).unwrap_err(),
            RagError::EmbeddingIdentityMismatch { .. }
        ));
        assert!(matches!(
            incompatible.index_documents("m1", &[doc("d2", &["new"])]).unwrap_err(),
            RagError::EmbeddingIdentityMismatch { .. }
        ));
    }
}
