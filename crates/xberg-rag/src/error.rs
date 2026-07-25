/// Errors returned by the RAG core.
#[derive(Debug, thiserror::Error)]
pub enum RagError {
    #[error("invalid matter id {matter_id:?}: matter ids cannot be empty, '.' or '..'")]
    InvalidMatterId { matter_id: String },
    #[error("dimension mismatch: expected {expected}, got {got}")]
    DimMismatch { expected: usize, got: usize },
    #[error("{operation} vector contains a non-finite value")]
    NonFiniteVector { operation: &'static str },
    #[error(
        "embedding identity mismatch: snapshot={snapshot:?}, embedder={embedder:?}; re-index the matter with the current embedder"
    )]
    EmbeddingIdentityMismatch {
        snapshot: Box<crate::EmbeddingIdentity>,
        embedder: Box<crate::EmbeddingIdentity>,
    },
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
    #[error("legacy mirror bundle: {0}")]
    Legacy(String),
    #[error("io: {0}")]
    Io(String),
    #[error("no indexed data for matter {0}")]
    MatterNotFound(String),
}

/// Convenience alias for fallible RAG operations.
pub type Result<T> = std::result::Result<T, RagError>;
