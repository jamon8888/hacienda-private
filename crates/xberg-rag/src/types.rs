use serde::{Deserialize, Serialize};

/// A chunk plus its dense embedding, ready to index.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct IndexedChunk {
    pub doc_id: String,
    pub chunk_index: u32,
    pub text: String,
    pub page: Option<u32>,
    pub citation: Option<String>,
    pub vector: Vec<f32>,
}

/// A search hit returned to a host (browser or MCP server).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct RetrievedChunk {
    pub doc_id: String,
    pub chunk_index: u32,
    pub text: String,
    pub score: f32,
    pub citation: Option<String>,
    pub page: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_chunk_roundtrips_through_serde() {
        let c = IndexedChunk {
            doc_id: "d1".into(),
            chunk_index: 3,
            text: "hello".into(),
            page: Some(2),
            citation: Some("d1:3".into()),
            vector: vec![0.1, 0.2, 0.3],
        };
        let json = serde_json::to_string(&c).unwrap();
        let back: IndexedChunk = serde_json::from_str(&json).unwrap();
        assert_eq!(c, back);
    }
}
