use crate::{IndexedChunk, RagError, Result, RetrievedChunk, SearchStore};

/// Exact (brute-force cosine) vector store. O(n) search — correct for any n,
/// fast enough for small matters, and the correctness oracle for P2's HNSW
/// backend.
#[derive(Debug)]
pub struct FlatStore {
    dim: usize,
    chunks: Vec<IndexedChunk>,
}

impl SearchStore for FlatStore {
    fn new(dim: usize) -> Self {
        Self {
            dim,
            chunks: Vec::new(),
        }
    }

    fn ingest(&mut self, items: &[IndexedChunk]) -> Result<()> {
        for it in items {
            if it.vector.len() != self.dim {
                return Err(RagError::DimMismatch {
                    expected: self.dim,
                    got: it.vector.len(),
                });
            }
            if !it.vector.iter().all(|value| value.is_finite()) {
                return Err(RagError::NonFiniteVector { operation: "ingest" });
            }
        }
        self.chunks.extend_from_slice(items);
        Ok(())
    }

    fn search(&self, query: &[f32], top_k: usize) -> Result<Vec<RetrievedChunk>> {
        if query.len() != self.dim {
            return Err(RagError::DimMismatch {
                expected: self.dim,
                got: query.len(),
            });
        }
        if !query.iter().all(|value| value.is_finite()) {
            return Err(RagError::NonFiniteVector { operation: "query" });
        }
        let mut scored: Vec<(f32, &IndexedChunk)> = self.chunks.iter().map(|c| (cosine(query, &c.vector), c)).collect();
        // Descending by score.
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        Ok(scored
            .into_iter()
            .take(top_k)
            .map(|(score, c)| RetrievedChunk {
                doc_id: c.doc_id.clone(),
                chunk_index: c.chunk_index,
                text: c.text.clone(),
                score,
                citation: c.citation.clone(),
                page: c.page,
            })
            .collect())
    }

    fn len(&self) -> usize {
        self.chunks.len()
    }

    fn snapshot(&self) -> Result<Vec<u8>> {
        crate::snapshot::encode(self.dim, &self.chunks)
    }

    fn load(bytes: &[u8]) -> Result<Self> {
        let (dim, chunks) = crate::snapshot::decode(bytes)?;
        let mut store = Self::new(dim);
        store.ingest(&chunks)?;
        Ok(store)
    }
}

/// Cosine similarity; 0.0 when either vector has zero norm.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na * nb) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(id: &str, idx: u32, v: Vec<f32>) -> IndexedChunk {
        IndexedChunk {
            doc_id: id.into(),
            chunk_index: idx,
            text: format!("{id}:{idx}"),
            page: None,
            citation: None,
            vector: v,
        }
    }

    #[test]
    fn search_returns_nearest_first() {
        let mut s = FlatStore::new(3);
        s.ingest(&[
            chunk("d", 0, vec![1.0, 0.0, 0.0]),
            chunk("d", 1, vec![0.0, 1.0, 0.0]),
            chunk("d", 2, vec![0.9, 0.1, 0.0]),
        ])
        .unwrap();
        let hits = s.search(&[1.0, 0.0, 0.0], 2).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].chunk_index, 0); // identical direction, score ~1.0
        assert_eq!(hits[1].chunk_index, 2); // next closest
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn ingest_rejects_wrong_dimension() {
        let mut s = FlatStore::new(3);
        let err = s.ingest(&[chunk("d", 0, vec![1.0, 0.0])]).unwrap_err();
        assert!(matches!(err, RagError::DimMismatch { expected: 3, got: 2 }));
    }

    #[test]
    fn ingest_rejects_non_finite_vectors() {
        let mut store = FlatStore::new(2);
        let err = store.ingest(&[chunk("d", 0, vec![f32::NAN, 0.0])]).unwrap_err();
        assert!(matches!(err, RagError::NonFiniteVector { operation: "ingest" }));

        let err = store.ingest(&[chunk("d", 0, vec![f32::INFINITY, 0.0])]).unwrap_err();
        assert!(matches!(err, RagError::NonFiniteVector { operation: "ingest" }));
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn search_rejects_non_finite_query() {
        let store = FlatStore::new(2);
        let err = store.search(&[0.0, f32::NEG_INFINITY], 1).unwrap_err();
        assert!(matches!(err, RagError::NonFiniteVector { operation: "query" }));
    }

    #[test]
    fn load_revalidates_archived_vectors() {
        let bytes = crate::snapshot::encode(2, &[chunk("d", 0, vec![f32::NAN, 0.0])]).unwrap();
        let err = FlatStore::load(&bytes).unwrap_err();
        assert!(matches!(err, RagError::NonFiniteVector { operation: "ingest" }));
    }
}
