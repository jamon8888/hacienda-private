use std::path::{Path, PathBuf};

use crate::{RagError, Result};

/// Percent-encode exactly like JavaScript's `encodeURIComponent`, so a matter's
/// directory name byte-matches the one the Node host writes
/// (`services/mcp-server/src/mirror.ts` `matterDir`). Both hosts must address
/// the same directory or a mirror written by one is invisible to the other.
///
/// Unreserved set per the ECMAScript spec: `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
pub fn encode_uri_component(s: &str) -> String {
    const UNRESERVED: &[u8] = b"-_.!~*'()";
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || UNRESERVED.contains(b) {
            out.push(*b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// Resolved on-disk locations for one matter's mirror.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatterPaths {
    /// `<mirrors_dir>/<encodeURIComponent(matter_id)>`
    pub dir: PathBuf,
}

impl MatterPaths {
    /// Resolve the directory for `matter_id` under `mirrors_dir`.
    pub fn new(mirrors_dir: &Path, matter_id: &str) -> Result<Self> {
        if matches!(matter_id, "" | "." | "..") {
            return Err(RagError::InvalidMatterId {
                matter_id: matter_id.to_string(),
            });
        }

        Ok(Self {
            dir: mirrors_dir.join(encode_uri_component(matter_id)),
        })
    }

    /// The xberg-rag snapshot written by [`crate::RagEngine`] (P1 `snapshot` format).
    pub fn snapshot(&self) -> PathBuf {
        self.dir.join("rag.snapshot")
    }

    /// The legacy JSON `MirrorBundle` written by the Node host / browser mirror push. Also the
    /// on-disk home of the opt-in sealed entity-graph blob (`graph.cipher`/`graph.salt`, see
    /// `crate::read_bundle_graph`) — the Node host writes the browser's mirror payload verbatim,
    /// so no separate file or table is needed to keep the graph's opaque bytes alongside it.
    pub fn legacy_bundle(&self) -> PathBuf {
        self.dir.join("bundle.json")
    }

    /// Cross-process lock serializing snapshot writes for this matter.
    pub(crate) fn write_lock(&self) -> PathBuf {
        self.dir.join("rag.snapshot.lock")
    }
}

/// Default mirrors root: `$XBERG_DATA_DIR/mirrors`, else `$HOME/.xberg/mirrors`
/// — the same layout `services/mcp-server/src/config.ts` `buildConfig` produces.
/// Falls back to a relative `.xberg/mirrors` when no home directory is known.
pub fn default_mirrors_dir() -> PathBuf {
    default_mirrors_dir_from(
        std::env::var_os("XBERG_DATA_DIR").map(PathBuf::from),
        std::env::home_dir(),
    )
}

fn default_mirrors_dir_from(data_dir: Option<PathBuf>, home_dir: Option<PathBuf>) -> PathBuf {
    if let Some(data_dir) = data_dir {
        return data_dir.join("mirrors");
    }
    match home_dir {
        Some(home) => home.join(".xberg").join("mirrors"),
        None => PathBuf::from(".xberg").join("mirrors"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_uri_component("abc-123_x.y~z"), "abc-123_x.y~z");
        assert_eq!(encode_uri_component("a b"), "a%20b");
        assert_eq!(encode_uri_component("a/b"), "a%2Fb");
        assert_eq!(encode_uri_component("a:b"), "a%3Ab");
        // Multi-byte UTF-8 is encoded byte-by-byte, same as JS.
        assert_eq!(encode_uri_component("é"), "%C3%A9");
        // JS-specific unreserved extras: encodeURIComponent leaves these alone,
        // unlike most Rust percent-encoders. This is the likeliest parity break.
        assert_eq!(encode_uri_component("!*'()"), "!*'()");
        // Reserved characters that MUST be escaped, with uppercase hex.
        assert_eq!(encode_uri_component("a+b"), "a%2Bb");
        assert_eq!(encode_uri_component("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_uri_component("#"), "%23");
        assert_eq!(encode_uri_component("%"), "%25");
    }

    #[test]
    fn matter_paths_compose_expected_files() {
        let p = MatterPaths::new(Path::new("/data/mirrors"), "m 1").unwrap();
        assert!(p.dir.ends_with("m%201"));
        assert!(p.snapshot().ends_with("rag.snapshot"));
        assert!(p.legacy_bundle().ends_with("bundle.json"));
    }

    #[test]
    fn rejects_matter_ids_that_escape_or_alias_the_mirrors_root() {
        for matter_id in ["", ".", ".."] {
            assert!(matches!(
                MatterPaths::new(Path::new("/data/mirrors"), matter_id),
                Err(RagError::InvalidMatterId { matter_id: rejected }) if rejected == matter_id
            ));
        }
    }

    #[test]
    fn data_dir_override_is_used_as_the_mirrors_root() {
        let dir = default_mirrors_dir_from(Some(PathBuf::from("/data/xberg")), None);
        assert_eq!(dir, PathBuf::from("/data/xberg/mirrors"));
    }

    #[test]
    fn home_and_relative_fallbacks_match_the_node_layout() {
        assert_eq!(
            default_mirrors_dir_from(None, Some(PathBuf::from("/home/user"))),
            PathBuf::from("/home/user/.xberg/mirrors")
        );
        assert_eq!(default_mirrors_dir_from(None, None), PathBuf::from(".xberg/mirrors"));
    }
}
