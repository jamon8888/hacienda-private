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
/// Stateless between calls: every query re-reads the matter's snapshot from disk (and, if the
/// Node host/browser mirror has newer data than that snapshot, re-embeds it first — see
/// [`Self::query`]).
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
    ///
    /// Before searching, re-imports the legacy bundle if it's newer than the snapshot (or no
    /// snapshot exists yet) — see [`Self::sync_from_legacy_if_stale`] — so a caller never has to
    /// separately run `import_legacy` after every mirror push before new documents are searchable.
    /// A sync failure only turns into an error when there's no existing snapshot to fall back on
    /// (e.g. a legacy bundle written by a future, not-yet-understood version, or a transient
    /// embedder failure) — otherwise every subsequent query for the matter would break on a single
    /// bad legacy write, even though the last-known-good snapshot is still perfectly usable.
    pub fn query(&self, matter_id: &str, text: &str, top_k: usize) -> Result<Vec<RetrievedChunk>> {
        let paths = self.paths(matter_id)?;
        let path = paths.snapshot();
        if let Err(sync_err) = self.sync_from_legacy_if_stale(&paths, matter_id) {
            if !path.exists() {
                return Err(sync_err);
            }
        }
        if !path.exists() {
            return Err(RagError::MatterNotFound(matter_id.to_string()));
        }
        let store = self.load_or_empty(&paths)?;
        let q = self.embedder.embed_query(text)?;
        store.search(&q, top_k)
    }

    /// Re-embeds the matter's legacy bundle into a fresh snapshot when it's newer than the
    /// existing snapshot (or there is no snapshot yet). A no-op when there's no legacy bundle at
    /// all — a matter that was never ingested via the Node host/browser mirror path stays a clean
    /// `MatterNotFound` for `query()`, exactly as before this existed.
    ///
    /// This re-embeds the matter's *entire* chunk set on every stale detection (matching
    /// `import_legacy`'s own "full rebuild" contract) rather than incrementally — an accepted
    /// cost at this app's realistic per-matter scale (see `import_legacy`'s doc comment); revisit
    /// only if a matter's chunk count grows large enough for this to matter in practice.
    fn sync_from_legacy_if_stale(&self, paths: &MatterPaths, matter_id: &str) -> Result<()> {
        let legacy_path = paths.legacy_bundle();
        // Cheap early exit for the common "never ingested" case, before paying for a lock
        // acquisition (which also creates the matter directory). Re-checked authoritatively below,
        // under the lock. Only a missing file is a legitimate no-op — a permission error or other
        // I/O failure must propagate, not be silently treated as "nothing to import."
        match std::fs::metadata(&legacy_path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(RagError::Io(format!("stat {}: {e}", legacy_path.display()))),
        }

        // Hold the write lock for the whole stale-check-then-import sequence: `index_documents`
        // mutates the snapshot under this same lock, and `import_legacy` fully rebuilds the
        // snapshot from the legacy bundle alone. If the staleness decision were made outside the
        // lock, chunks a concurrent `index_documents` appended between the check and the (by then
        // stale) rebuild would be silently discarded when the rebuild overwrites a snapshot it
        // never saw. Call the non-locking `import_legacy_locked` below, not `import_legacy` — the
        // latter would try to re-acquire this same lock and deadlock.
        let _write_lock = self.acquire_write_lock(paths)?;
        let legacy_meta = match std::fs::metadata(&legacy_path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(RagError::Io(format!("stat {}: {e}", legacy_path.display()))),
        };
        let needs_import = match std::fs::metadata(paths.snapshot()) {
            Ok(snapshot_meta) => {
                let legacy_modified = legacy_meta
                    .modified()
                    .map_err(|e| RagError::Io(format!("stat {}: {e}", legacy_path.display())))?;
                let snapshot_modified = snapshot_meta
                    .modified()
                    .map_err(|e| RagError::Io(format!("stat {}: {e}", paths.snapshot().display())))?;
                legacy_modified > snapshot_modified
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Err(e) => return Err(RagError::Io(format!("stat {}: {e}", paths.snapshot().display()))),
        };
        if needs_import {
            self.import_legacy_locked(paths, matter_id)?;
        }
        Ok(())
    }

    /// Rebuild a matter's snapshot from a legacy JSON `MirrorBundle` by
    /// re-embedding its chunk texts. Replaces any existing snapshot unless the
    /// bundle is empty, in which case it is a no-op that leaves any existing
    /// snapshot untouched; returns the number of chunks imported.
    pub fn import_legacy(&self, matter_id: &str) -> Result<usize> {
        let paths = self.paths(matter_id)?;
        let _write_lock = self.acquire_write_lock(&paths)?;
        self.import_legacy_locked(&paths, matter_id)
    }

    /// Body of [`Self::import_legacy`], assuming the caller already holds `paths`' write lock.
    /// Split out so [`Self::sync_from_legacy_if_stale`] can recheck freshness and perform the
    /// rebuild under a single lock acquisition, instead of two (which would let another writer's
    /// change slip in between the check and the rebuild).
    fn import_legacy_locked(&self, paths: &MatterPaths, matter_id: &str) -> Result<usize> {
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
        self.save(paths, &store)?;
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
    fn concurrent_index_documents_call_is_not_lost_to_a_racing_legacy_import() {
        // Regression test for a race where `sync_from_legacy_if_stale`'s staleness decision was
        // made outside the write lock: a concurrent `index_documents` call could append a chunk
        // in the window between that check and `import_legacy`'s full rebuild, which then
        // silently discarded it by rebuilding the snapshot from the legacy bundle alone. Fixed by
        // holding the lock (and rechecking freshness under it) for the whole check-then-rebuild
        // sequence — see `sync_from_legacy_if_stale`.
        let tmp = tempfile::tempdir().unwrap();
        let mirrors_dir = tmp.path().to_path_buf();
        let paths = MatterPaths::new(&mirrors_dir, "m1").unwrap();

        // No snapshot exists yet, so the staleness check is unconditionally "needs_import = true"
        // (the "no snapshot" branch) no matter which thread below wins the lock race — this makes
        // the scenario reproducible without depending on sub-second filesystem mtime resolution.
        write_legacy_bundle(
            &paths,
            r#"{"doc_id":"legacy","chunk_index":0,"text":"legacy content","score":0.1,"citation":"legacy:0"}"#,
        );

        // Both threads embed (and hit the barrier) before either acquires the write lock — see
        // `SynchronizedEmbedder` — maximizing the chance they contend for the lock in either order.
        let barrier = Arc::new(Barrier::new(2));

        let import_engine = RagEngine::new(
            SynchronizedEmbedder {
                inner: MockEmbedder::new(16),
                barrier: Arc::clone(&barrier),
            },
            mirrors_dir.clone(),
        );
        let import_handle = std::thread::spawn(move || import_engine.query("m1", "legacy content", 5));

        let index_engine = RagEngine::new(
            SynchronizedEmbedder {
                inner: MockEmbedder::new(16),
                barrier: Arc::clone(&barrier),
            },
            mirrors_dir.clone(),
        );
        let index_handle =
            std::thread::spawn(move || index_engine.index_documents("m1", &[doc("concurrent", &["concurrent content"])]));

        import_handle.join().unwrap().unwrap();
        index_handle.join().unwrap().unwrap();

        let hits = engine(&mirrors_dir).query("m1", "content", 10).unwrap();
        assert!(
            hits.iter().any(|h| h.text == "concurrent content"),
            "concurrent index_documents chunk was lost to a racing legacy import rebuild: {hits:?}"
        );
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

    fn write_legacy_bundle(paths: &MatterPaths, chunks_json: &str) {
        std::fs::create_dir_all(&paths.dir).unwrap();
        std::fs::write(
            paths.legacy_bundle(),
            format!(r#"{{"version":1,"index":[],"vault":[],"pii":[],"chunks":[{chunks_json}]}}"#),
        )
        .unwrap();
    }

    fn set_mtime(path: &Path, time: std::time::SystemTime) {
        let file = OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(time).unwrap();
    }

    #[test]
    fn query_imports_a_fresh_legacy_bundle_when_no_snapshot_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        let paths = MatterPaths::new(tmp.path(), "m1").unwrap();
        write_legacy_bundle(
            &paths,
            r#"{"doc_id":"d1","chunk_index":0,"text":"fresh from the mirror","score":0.1,"citation":"d1:0"}"#,
        );

        // No index_documents/import_legacy call first — query() alone must pick this up.
        let hits = e.query("m1", "fresh from the mirror", 1).unwrap();
        assert_eq!(hits[0].text, "fresh from the mirror");
    }

    #[test]
    fn query_reimports_when_the_legacy_bundle_is_newer_than_the_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        e.index_documents("m1", &[doc("d1", &["stale snapshot content"])])
            .unwrap();

        let paths = MatterPaths::new(tmp.path(), "m1").unwrap();
        let snapshot_time = std::fs::metadata(paths.snapshot()).unwrap().modified().unwrap();
        write_legacy_bundle(
            &paths,
            r#"{"doc_id":"d2","chunk_index":0,"text":"newer mirror content","score":0.1,"citation":"d2:0"}"#,
        );
        // Force a strictly-newer mtime: some filesystems have coarse enough mtime resolution
        // that two writes microseconds apart could otherwise land on the same tick.
        set_mtime(
            &paths.legacy_bundle(),
            snapshot_time + std::time::Duration::from_secs(1),
        );

        let hits = e.query("m1", "newer mirror content", 5).unwrap();
        assert_eq!(hits[0].text, "newer mirror content");
        // import_legacy fully replaces the snapshot, so the stale content is gone.
        assert!(hits.iter().all(|h| h.text != "stale snapshot content"));
    }

    #[test]
    fn query_skips_reimport_when_the_snapshot_is_already_newer() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        let paths = MatterPaths::new(tmp.path(), "m1").unwrap();
        // Deliberately unparseable — if query() ever attempted to import this, it would error.
        write_legacy_bundle(&paths, "");
        std::fs::write(paths.legacy_bundle(), "not a valid MirrorBundle at all").unwrap();
        let legacy_time = std::fs::metadata(paths.legacy_bundle()).unwrap().modified().unwrap();

        e.index_documents("m1", &[doc("d1", &["indexed after the bad bundle"])])
            .unwrap();
        set_mtime(&paths.snapshot(), legacy_time + std::time::Duration::from_secs(1));

        // Must succeed: the newer, valid snapshot is used directly, the invalid bundle is never touched.
        let hits = e.query("m1", "indexed after the bad bundle", 1).unwrap();
        assert_eq!(hits[0].text, "indexed after the bad bundle");
    }

    #[test]
    fn query_falls_back_to_the_stale_snapshot_when_a_newer_legacy_bundle_fails_to_import() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        e.index_documents("m1", &[doc("d1", &["last known good"])]).unwrap();

        let paths = MatterPaths::new(tmp.path(), "m1").unwrap();
        let snapshot_time = std::fs::metadata(paths.snapshot()).unwrap().modified().unwrap();
        // Newer than the snapshot, but not a valid MirrorBundle at all -- import_legacy would error.
        std::fs::write(paths.legacy_bundle(), "not a valid MirrorBundle at all").unwrap();
        set_mtime(
            &paths.legacy_bundle(),
            snapshot_time + std::time::Duration::from_secs(1),
        );

        // Must succeed by falling back to the stale-but-usable snapshot, not error out entirely --
        // and repeated queries must keep succeeding the same way, not get stuck erroring forever.
        for _ in 0..2 {
            let hits = e.query("m1", "last known good", 1).unwrap();
            assert_eq!(hits[0].text, "last known good");
        }
    }

    #[test]
    fn query_errors_when_the_only_newer_legacy_bundle_fails_to_import_and_no_snapshot_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let e = engine(tmp.path());
        let paths = MatterPaths::new(tmp.path(), "m1").unwrap();
        std::fs::create_dir_all(&paths.dir).unwrap();
        std::fs::write(paths.legacy_bundle(), "not a valid MirrorBundle at all").unwrap();

        // No snapshot to fall back on, so the sync failure is the only signal available.
        assert!(matches!(e.query("m1", "anything", 1).unwrap_err(), RagError::Legacy(_)));
    }
}
