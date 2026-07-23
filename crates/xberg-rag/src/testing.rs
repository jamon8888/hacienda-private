//! Test-only embedding backend. Enabled by the `testing` feature so downstream
//! crates (`xberg-cli` integration tests) can build an engine with no model on
//! disk and no network — the CI constraint from the spec.

use crate::{Embedder, Result};

/// Deterministic hash-based embedder: same text always yields the same vector,
/// different texts yield different directions. Not semantically meaningful —
/// it exists so engine/store behaviour can be asserted exactly.
#[derive(Debug, Clone)]
pub struct MockEmbedder {
    dim: usize,
}

impl MockEmbedder {
    /// Create a mock embedder producing `dim`-dimensional vectors.
    pub fn new(dim: usize) -> Self {
        assert!(dim > 0, "mock embedding dimension must be greater than zero");
        Self { dim }
    }

    /// FNV-1a over the bytes, then one f32 per dimension derived by re-mixing
    /// the hash with the dimension index. Pure, allocation-light, no deps.
    fn vector_for(&self, text: &str) -> Vec<f32> {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for b in text.as_bytes() {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        (0..self.dim)
            .map(|i| {
                let mut h = hash ^ (i as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
                h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
                h ^= h >> 33;
                // Map the low 24 bits into [-1.0, 1.0).
                ((h & 0x00ff_ffff) as f32 / 8_388_608.0) - 1.0
            })
            .collect()
    }
}

impl Embedder for MockEmbedder {
    fn dim(&self) -> usize {
        self.dim
    }

    fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|t| self.vector_for(t)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_is_deterministic_and_correctly_sized() {
        let e = MockEmbedder::new(8);
        let a = e.embed_documents(&["hello".to_string()]).unwrap();
        let b = e.embed_documents(&["hello".to_string()]).unwrap();
        assert_eq!(a, b);
        assert_eq!(a[0].len(), 8);
    }

    #[test]
    fn different_text_yields_different_vector() {
        let e = MockEmbedder::new(8);
        let a = e.embed_query("hello").unwrap();
        let b = e.embed_query("goodbye").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    #[should_panic(expected = "mock embedding dimension must be greater than zero")]
    fn zero_dimension_is_rejected() {
        let _ = MockEmbedder::new(0);
    }
}
