use crate::{RagError, Result};
use serde::Deserialize;

/// One chunk recovered from a legacy JSON `MirrorBundle`.
///
/// Deliberately carries no vector: the bundle's `index` field holds EdgeVec's
/// opaque serialized bytes, which this crate never parses. Callers re-embed
/// [`LegacyChunk::text`] to rebuild a searchable store.
#[derive(Debug, Clone, PartialEq)]
pub struct LegacyChunk {
    pub doc_id: String,
    pub chunk_index: u32,
    pub text: String,
    pub page: Option<u32>,
    pub citation: Option<String>,
}

#[derive(Deserialize)]
struct RawBundle {
    version: u32,
    chunks: Vec<RawChunk>,
}

/// The sealed droit-des-affaires entity graph attached to a `MirrorBundle`
/// (`packages/wasm-pipeline/src/entity-graph.ts`), present only when the browser opted into
/// entity-graph extraction at ingest time. Opaque ciphertext — this crate never decrypts it; a
/// future `graph_query` MCP tool does, passphrase-gated, in an ephemeral in-memory store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedGraph {
    pub cipher: Vec<u8>,
    pub salt: Vec<u8>,
}

#[derive(Deserialize)]
struct RawGraph {
    cipher: Vec<u8>,
    salt: Vec<u8>,
}

#[derive(Deserialize)]
struct RawBundleGraph {
    #[serde(default)]
    graph: Option<RawGraph>,
}

#[derive(Deserialize)]
struct RawChunk {
    doc_id: String,
    chunk_index: u32,
    text: String,
    #[serde(default)]
    page: Option<u32>,
    #[serde(default)]
    citation: Option<String>,
}

/// Parse the `chunks[]` of a Node-host/browser `MirrorBundle` (`version: 1` or `2`).
///
/// `index`, `vault`, `vaultSalt`, `pii`, and (for `version: 2`) `embedding_identity` are ignored —
/// this reader exists only to recover enough text to re-index; PII and vault handling stay with
/// their existing owners. Both versions carry the same `chunks[]` shape (`RawChunk`'s fields are a
/// strict subset of what version 2 also has), so accepting either is a version-number-only change.
pub fn read_bundle_chunks(json: &[u8]) -> Result<Vec<LegacyChunk>> {
    let raw: RawBundle =
        serde_json::from_slice(json).map_err(|e| RagError::Legacy(format!("not a valid MirrorBundle: {e}")))?;
    if raw.version != 1 && raw.version != 2 {
        return Err(RagError::Legacy(format!("unsupported bundle version {}", raw.version)));
    }
    Ok(raw
        .chunks
        .into_iter()
        .map(|c| LegacyChunk {
            doc_id: c.doc_id,
            chunk_index: c.chunk_index,
            text: c.text,
            page: c.page,
            citation: c.citation,
        })
        .collect())
}

/// Read just the sealed entity-graph blob from a `MirrorBundle`, if present. `Ok(None)` is the
/// common case — entity-graph extraction is opt-in, so most bundles carry no `graph` field at
/// all — only a `graph` field that's present but malformed is an error.
pub fn read_bundle_graph(json: &[u8]) -> Result<Option<SealedGraph>> {
    let raw: RawBundleGraph =
        serde_json::from_slice(json).map_err(|e| RagError::Legacy(format!("not a valid MirrorBundle: {e}")))?;
    Ok(raw.graph.map(|g| SealedGraph {
        cipher: g.cipher,
        salt: g.salt,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE: &str = r#"{
        "version": 1,
        "index": [1, 2, 3],
        "vault": [],
        "pii": [{"doc_id":"d1","kind":"PERSON","start":0,"end":4,"token":"[P1]"}],
        "chunks": [
            {"doc_id":"d1","chunk_index":0,"text":"first","page":1,"score":0.9,"citation":"d1:0"},
            {"doc_id":"d1","chunk_index":1,"text":"second","score":0.4,"citation":"d1:1"}
        ]
    }"#;

    #[test]
    fn reads_chunks_ignoring_index_and_pii() {
        let chunks = read_bundle_chunks(BUNDLE.as_bytes()).unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].text, "first");
        assert_eq!(chunks[0].page, Some(1));
        assert_eq!(chunks[0].citation.as_deref(), Some("d1:0"));
        assert_eq!(chunks[1].page, None);
    }

    #[test]
    fn reads_version_2_bundles_ignoring_embedding_identity() {
        let bundle = r#"{
            "version": 2,
            "embedding_identity": "ibm-granite/granite-embedding-97m-multilingual-r2",
            "index": [1, 2, 3],
            "vault": [],
            "vaultSalt": [],
            "pii": [],
            "chunks": [
                {"doc_id":"d1","chunk_index":0,"text":"first","page":1,"citation":"d1:0"}
            ]
        }"#;
        let chunks = read_bundle_chunks(bundle.as_bytes()).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "first");
    }

    #[test]
    fn rejects_unknown_bundle_version() {
        let bad = r#"{"version": 3, "chunks": []}"#;
        let err = read_bundle_chunks(bad.as_bytes()).unwrap_err();
        assert!(matches!(err, RagError::Legacy(_)));
    }

    #[test]
    fn rejects_non_json() {
        assert!(matches!(
            read_bundle_chunks(b"not json").unwrap_err(),
            RagError::Legacy(_)
        ));
    }

    #[test]
    fn read_bundle_graph_is_none_when_the_bundle_has_no_graph_field() {
        assert_eq!(read_bundle_graph(BUNDLE.as_bytes()).unwrap(), None);
    }

    #[test]
    fn read_bundle_graph_reads_the_sealed_cipher_and_salt_when_present() {
        let bundle = r#"{
            "version": 2,
            "chunks": [],
            "graph": { "cipher": [1, 2, 3], "salt": [4, 5] }
        }"#;
        let graph = read_bundle_graph(bundle.as_bytes()).unwrap().unwrap();
        assert_eq!(graph.cipher, vec![1, 2, 3]);
        assert_eq!(graph.salt, vec![4, 5]);
    }

    #[test]
    fn read_bundle_graph_rejects_non_json() {
        assert!(matches!(
            read_bundle_graph(b"not json").unwrap_err(),
            RagError::Legacy(_)
        ));
    }
}
