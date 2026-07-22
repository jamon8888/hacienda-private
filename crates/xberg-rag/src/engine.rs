use std::path::{Path, PathBuf};

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

impl<E: Embedder> RagEngine<E> {
    /// Build an engine writing under `mirrors_dir` (see [`crate::default_mirrors_dir`]).
    pub fn new(embedder: E, mirrors_dir: PathBuf) -> Self {
        Self { embedder, mirrors_dir }
    }

    /// The mirrors root this engine reads and writes.
    pub fn mirrors_dir(&self) -> &Path {
        &self.mirrors_dir
    }

    fn paths(&self, matter_id: &str) -> MatterPaths {
        MatterPaths::new(&self.mirrors_dir, matter_id)
    }

    /// Load a matter's store, or an empty one when it has no snapshot yet.
    fn load_or_empty(&self, matter_id: &str) -> Result<FlatStore> {
        let path = self.paths(matter_id).snapshot();
        if !path.exists() {
            return Ok(FlatStore::new(self.embedder.dim()));
        }
        let bytes = std::fs::read(&path).map_err(|e| RagError::Io(format!("read {}: {e}", path.display())))?;
        FlatStore::load(&bytes)
    }

    /// Write a store's snapshot atomically: stage to a sibling temp file, then
    /// rename over the target. A crash never leaves a torn snapshot — the same
    /// guarantee the Node host gives for its mirror directory.
    fn save(&self, matter_id: &str, store: &FlatStore) -> Result<()> {
        let paths = self.paths(matter_id);
        std::fs::create_dir_all(&paths.dir)
            .map_err(|e| RagError::Io(format!("create {}: {e}", paths.dir.display())))?;
        let final_path = paths.snapshot();
        let tmp_path = paths.dir.join("rag.snapshot.tmp");
        let bytes = store.snapshot()?;
        std::fs::write(&tmp_path, &bytes).map_err(|e| RagError::Io(format!("write {}: {e}", tmp_path.display())))?;
        std::fs::rename(&tmp_path, &final_path)
            .map_err(|e| RagError::Io(format!("rename into {}: {e}", final_path.display())))?;
        Ok(())
    }

    /// Embed and index `docs` into `matter_id`, adding to whatever is already
    /// indexed. Returns the matter's total chunk count after the write.
    pub fn index_documents(&self, matter_id: &str, docs: &[DocumentInput]) -> Result<usize> {
        let mut texts: Vec<String> = Vec::new();
        let mut meta: Vec<(String, u32, Option<u32>)> = Vec::new();
        for doc in docs {
            for (i, chunk) in doc.chunks.iter().enumerate() {
                texts.push(chunk.text.clone());
                meta.push((doc.doc_id.clone(), i as u32, chunk.page));
            }
        }
        if texts.is_empty() {
            return Ok(self.load_or_empty(matter_id)?.len());
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

        let mut store = self.load_or_empty(matter_id)?;
        store.ingest(&items)?;
        self.save(matter_id, &store)?;
        Ok(store.len())
    }

    /// Live search: embed `text` and search the matter's actual vectors.
    ///
    /// This is the behaviour the Node host could not provide — its
    /// `MirrorStore.retrieve()` ignored the query and re-sorted mirrored chunks
    /// by a mirror-time placeholder score.
    pub fn query(&self, matter_id: &str, text: &str, top_k: usize) -> Result<Vec<RetrievedChunk>> {
        let path = self.paths(matter_id).snapshot();
        if !path.exists() {
            return Err(RagError::MatterNotFound(matter_id.to_string()));
        }
        let store = self.load_or_empty(matter_id)?;
        let q = self.embedder.embed_query(text)?;
        store.search(&q, top_k)
    }

    /// Rebuild a matter's snapshot from a legacy JSON `MirrorBundle` by
    /// re-embedding its chunk texts. Replaces any existing snapshot; returns the
    /// number of chunks imported.
    pub fn import_legacy(&self, matter_id: &str) -> Result<usize> {
        let path = self.paths(matter_id).legacy_bundle();
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

        let mut store = FlatStore::new(self.embedder.dim());
        store.ingest(&items)?;
        let count = store.len();
        self.save(matter_id, &store)?;
        Ok(count)
    }
}

#[cfg(all(test, feature = "testing"))]
mod tests {
    use super::*;
    use crate::MockEmbedder;

    fn engine(dir: &Path) -> RagEngine<MockEmbedder> {
        RagEngine::new(MockEmbedder::new(16), dir.to_path_buf())
    }

    fn doc(id: &str, texts: &[&str]) -> DocumentInput {
        DocumentInput {
            doc_id: id.to_string(),
            chunks: texts
                .iter()
                .map(|t| ChunkInput { text: (*t).to_string(), page: None })
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
        e.index_documents("m1", &[doc("d1", &["alpha content", "beta content"])]).unwrap();

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
        let paths = MatterPaths::new(tmp.path(), "m1");
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
}
