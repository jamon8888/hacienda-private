//! End-to-end tests for `xberg rag`. Uses `--embedder mock` so no model is
//! downloaded — the workspace forbids model egress in CI.

use std::path::PathBuf;
use std::process::Command;
use tempfile::tempdir;

fn binary() -> String {
    format!("{}/../../target/debug/xberg", env!("CARGO_MANIFEST_DIR"))
}

fn write(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, body).unwrap();
    p
}

#[test]
fn index_then_query_returns_the_matching_document() {
    let data = tempdir().unwrap();
    let docs = tempdir().unwrap();
    write(docs.path(), "a.md", "Contract renewal terms and the notice period.");
    write(docs.path(), "b.md", "Employee onboarding checklist for new hires.");

    let index = Command::new(binary())
        .args([
            "rag", "index",
            "--matter", "m1",
            "--input", docs.path().to_str().unwrap(),
            "--mirrors-dir", data.path().to_str().unwrap(),
            "--embedder", "mock",
        ])
        .output()
        .expect("failed to run xberg rag index");
    assert!(index.status.success(), "stderr: {}", String::from_utf8_lossy(&index.stderr));

    let query = Command::new(binary())
        .args([
            "rag", "query",
            "--matter", "m1",
            "--text", "Employee onboarding checklist for new hires.",
            "--top-k", "2",
            "--mirrors-dir", data.path().to_str().unwrap(),
            "--embedder", "mock",
            "--format", "json",
        ])
        .output()
        .expect("failed to run xberg rag query");
    assert!(query.status.success(), "stderr: {}", String::from_utf8_lossy(&query.stderr));

    let stdout = String::from_utf8_lossy(&query.stdout);
    let hits: serde_json::Value = serde_json::from_str(&stdout).expect("query output must be JSON");
    let arr = hits.as_array().expect("expected a JSON array of hits");
    assert!(!arr.is_empty(), "expected at least one hit");
    assert_eq!(
        arr[0]["doc_id"].as_str().unwrap(),
        "b.md",
        "the query text is b.md's content, so b.md must rank first"
    );
}

#[test]
fn query_on_an_unindexed_matter_fails_cleanly() {
    let data = tempdir().unwrap();
    let out = Command::new(binary())
        .args([
            "rag", "query",
            "--matter", "ghost",
            "--text", "anything",
            "--mirrors-dir", data.path().to_str().unwrap(),
            "--embedder", "mock",
        ])
        .output()
        .expect("failed to run xberg rag query");
    assert!(!out.status.success());
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("ghost"), "error must name the matter; got: {stderr}");
}
