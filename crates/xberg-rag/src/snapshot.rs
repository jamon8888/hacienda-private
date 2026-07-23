use crate::{IndexedChunk, RagError, Result};
use rkyv::rancor::Error as RkyvError;

/// Magic prefix identifying an xberg-rag snapshot blob.
const SNAPSHOT_MAGIC: [u8; 4] = *b"XRAG";
/// On-disk snapshot format version. Bump on any layout change.
pub const SNAPSHOT_VERSION: u16 = 1;
// 4 magic + 2 version + 10 reserved (zeroed) bytes. The reserved bytes pad
// the header to a 16-byte boundary so the rkyv-archived body that follows
// always starts 16-byte aligned. That keeps a future zero-copy `mmap` read
// of the archive possible (no realignment copy needed on that path) and
// leaves room for future format flags without another layout change.
const HEADER_LEN: usize = 16;

#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
struct SnapshotBody {
    dim: u32,
    chunks: Vec<IndexedChunk>,
}

pub(crate) fn encode(dim: usize, chunks: &[IndexedChunk]) -> Result<Vec<u8>> {
    let dim =
        u32::try_from(dim).map_err(|_| RagError::Snapshot(format!("embedding dimension {dim} exceeds u32::MAX")))?;
    let body = SnapshotBody {
        dim,
        chunks: chunks.to_vec(),
    };
    let archived = rkyv::to_bytes::<RkyvError>(&body).map_err(|e| RagError::Snapshot(e.to_string()))?;
    let mut out = Vec::with_capacity(HEADER_LEN + archived.len());
    out.extend_from_slice(&SNAPSHOT_MAGIC);
    out.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
    out.extend_from_slice(&[0u8; HEADER_LEN - 6]); // reserved, must stay zero for now
    out.extend_from_slice(&archived);
    Ok(out)
}

pub(crate) fn decode(bytes: &[u8]) -> Result<(usize, Vec<IndexedChunk>)> {
    if bytes.len() < HEADER_LEN {
        return Err(RagError::SnapshotTooShort(bytes.len()));
    }
    if bytes[0..4] != SNAPSHOT_MAGIC {
        return Err(RagError::BadMagic);
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    if version != SNAPSHOT_VERSION {
        return Err(RagError::UnsupportedVersion(version));
    }
    // Bytes [6..HEADER_LEN] are reserved for future flags and are not
    // validated here: a future writer may set them, and this reader must
    // not reject a snapshot just because they're non-zero.
    // The archived payload requires proper alignment for its root pointer,
    // but `bytes[HEADER_LEN..]` inherits whatever alignment the caller's
    // buffer happened to have at offset `HEADER_LEN`, which is not
    // guaranteed by a plain `&[u8]`. Copy into a freshly-allocated aligned
    // buffer before validating/deserializing.
    let mut aligned = rkyv::util::AlignedVec::<16>::new();
    aligned.extend_from_slice(&bytes[HEADER_LEN..]);
    let body: SnapshotBody =
        rkyv::from_bytes::<SnapshotBody, RkyvError>(&aligned).map_err(|e| RagError::Snapshot(e.to_string()))?;
    Ok((body.dim as usize, body.chunks))
}

#[cfg(test)]
mod tests {
    use crate::{FlatStore, IndexedChunk, RagError, SearchStore};

    use super::encode;

    fn store_with_two() -> FlatStore {
        let mut s = FlatStore::new(3);
        s.ingest(&[
            IndexedChunk {
                doc_id: "d".into(),
                chunk_index: 0,
                text: "a".into(),
                page: Some(1),
                citation: Some("d:0".into()),
                vector: vec![1.0, 0.0, 0.0],
            },
            IndexedChunk {
                doc_id: "d".into(),
                chunk_index: 1,
                text: "b".into(),
                page: None,
                citation: None,
                vector: vec![0.0, 1.0, 0.0],
            },
        ])
        .unwrap();
        s
    }

    #[test]
    fn snapshot_roundtrip_preserves_search() {
        let s = store_with_two();
        let bytes = s.snapshot().unwrap();
        let restored = FlatStore::load(&bytes).unwrap();
        assert_eq!(restored.len(), 2);
        let a = s.search(&[1.0, 0.0, 0.0], 1).unwrap();
        let b = restored.search(&[1.0, 0.0, 0.0], 1).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn decode_rejects_bad_magic() {
        let mut bytes = store_with_two().snapshot().unwrap();
        bytes[0] = b'Z';
        assert!(matches!(FlatStore::load(&bytes).unwrap_err(), RagError::BadMagic));
    }

    #[test]
    fn decode_rejects_short_input() {
        assert!(matches!(
            FlatStore::load(&[1, 2]).unwrap_err(),
            RagError::SnapshotTooShort(2)
        ));
    }

    #[test]
    fn body_starts_16_byte_aligned_for_future_zero_copy_mmap() {
        use super::{HEADER_LEN, SNAPSHOT_VERSION};

        assert_eq!(HEADER_LEN % 16, 0, "archive must begin on a 16-byte boundary");
        let bytes = store_with_two().snapshot().unwrap();
        assert!(bytes.len() > HEADER_LEN);
        assert_eq!(&bytes[0..4], b"XRAG");
        assert_eq!(u16::from_le_bytes([bytes[4], bytes[5]]), SNAPSHOT_VERSION);
        assert!(
            bytes[6..HEADER_LEN].iter().all(|b| *b == 0),
            "reserved bytes must be zero"
        );
    }

    #[test]
    #[cfg(target_pointer_width = "64")]
    fn encode_rejects_dimensions_larger_than_snapshot_format() {
        let dim = usize::try_from(u64::from(u32::MAX) + 1).unwrap();
        let err = encode(dim, &[]).unwrap_err();
        assert!(matches!(err, RagError::Snapshot(message) if message.contains("exceeds u32::MAX")));
    }
}
