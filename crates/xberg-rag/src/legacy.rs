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

/// Parse the `chunks[]` of a Node-host `MirrorBundle` (`version: 1`).
///
/// `index`, `vault`, and `pii` are ignored — this reader exists only to recover
/// enough text to re-index; PII and vault handling stay with their existing owners.
pub fn read_bundle_chunks(json: &[u8]) -> Result<Vec<LegacyChunk>> {
    let raw: RawBundle =
        serde_json::from_slice(json).map_err(|e| RagError::Legacy(format!("not a valid MirrorBundle: {e}")))?;
    if raw.version != 1 {
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
    fn rejects_unknown_bundle_version() {
        let bad = r#"{"version": 2, "chunks": []}"#;
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
}
