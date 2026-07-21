use crate::{IndexedChunk, RagError, Result};

pub(crate) fn encode(_dim: usize, _chunks: &[IndexedChunk]) -> Result<Vec<u8>> {
    Err(RagError::Snapshot("unimplemented (Task 4)".into()))
}

pub(crate) fn decode(_bytes: &[u8]) -> Result<(usize, Vec<IndexedChunk>)> {
    Err(RagError::Snapshot("unimplemented (Task 4)".into()))
}
