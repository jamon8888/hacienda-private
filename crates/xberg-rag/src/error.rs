/// Errors returned by the RAG core.
#[derive(Debug, thiserror::Error)]
pub enum RagError {
    #[error("dimension mismatch: expected {expected}, got {got}")]
    DimMismatch { expected: usize, got: usize },
    #[error("snapshot too short: {0} bytes")]
    SnapshotTooShort(usize),
    #[error("bad snapshot magic")]
    BadMagic,
    #[error("unsupported snapshot version: {0}")]
    UnsupportedVersion(u16),
    #[error("snapshot (de)serialization failed: {0}")]
    Snapshot(String),
    #[error("embedding failed: {0}")]
    Embed(String),
}

/// Convenience alias for fallible RAG operations.
pub type Result<T> = std::result::Result<T, RagError>;
