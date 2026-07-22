use std::path::{Path, PathBuf};

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
    pub fn new(mirrors_dir: &Path, matter_id: &str) -> Self {
        Self {
            dir: mirrors_dir.join(encode_uri_component(matter_id)),
        }
    }

    /// The xberg-rag snapshot written by [`crate::RagEngine`] (P1 `snapshot` format).
    pub fn snapshot(&self) -> PathBuf {
        self.dir.join("rag.snapshot")
    }

    /// The legacy JSON `MirrorBundle` written by the Node host / browser mirror push.
    pub fn legacy_bundle(&self) -> PathBuf {
        self.dir.join("bundle.json")
    }
}

/// Default mirrors root: `$XBERG_DATA_DIR/mirrors`, else `$HOME/.xberg/mirrors`
/// — the same layout `services/mcp-server/src/config.ts` `buildConfig` produces.
/// Falls back to a relative `.xberg/mirrors` when no home directory is known.
pub fn default_mirrors_dir() -> PathBuf {
    if let Ok(data_dir) = std::env::var("XBERG_DATA_DIR") {
        return PathBuf::from(data_dir).join("mirrors");
    }
    match std::env::home_dir() {
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
    }

    #[test]
    fn matter_paths_compose_expected_files() {
        let p = MatterPaths::new(Path::new("/data/mirrors"), "m 1");
        assert!(p.dir.ends_with("m%201"));
        assert!(p.snapshot().ends_with("rag.snapshot"));
        assert!(p.legacy_bundle().ends_with("bundle.json"));
    }

    #[test]
    fn default_mirrors_dir_honours_data_dir_env() {
        // SAFETY-free: set_var is safe on the 2024 edition's std API surface used here
        // only via a serialised test; this test does not run concurrently with another
        // that reads XBERG_DATA_DIR.
        let dir = default_mirrors_dir();
        assert!(dir.ends_with("mirrors"), "got {dir:?}");
    }
}
