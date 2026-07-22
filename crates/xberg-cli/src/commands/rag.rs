//! `xberg rag` — native RAG index/query over the on-disk matter store.
//!
//! This is the native half of the isomorphic core: the same `xberg_rag` engine
//! the browser host binds through WASM, driven here from the command line.

use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
use xberg::chunking::chunk_for_rag;
use xberg::core::config::ChunkingConfig;
use xberg_rag::{ChunkInput, DocumentInput, RagEngine, default_mirrors_dir};

/// Which embedding backend the command should use.
///
/// `mock` exists so the CLI (and its integration tests) can exercise the whole
/// index/query path with no model on disk and no network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum EmbedderKind {
    /// Bundled preset via xberg's embedding engine (downloads on first use).
    Preset,
    /// Deterministic hash embedder — tests and smoke checks only.
    Mock,
}

fn mirrors_root(explicit: Option<PathBuf>) -> PathBuf {
    explicit.unwrap_or_else(default_mirrors_dir)
}

/// Read every UTF-8 text file directly under `input` (or `input` itself if it is
/// a file) and chunk it for indexing. Binary formats are P4's `ingest_folder`
/// tool, which routes through the full extraction pipeline; this command is
/// deliberately limited to text so it stays a thin, fast test surface.
fn collect_documents(input: &Path, chunk_size: usize) -> Result<Vec<DocumentInput>> {
    let config = ChunkingConfig {
        max_characters: chunk_size,
        ..ChunkingConfig::default()
    };

    let files: Vec<PathBuf> = if input.is_file() {
        vec![input.to_path_buf()]
    } else {
        let mut v: Vec<PathBuf> = std::fs::read_dir(input)
            .with_context(|| format!("failed to read directory {}", input.display()))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect();
        // Deterministic order so a re-index assigns the same chunk indices.
        v.sort();
        v
    };

    let mut docs = Vec::new();
    for path in files {
        let Ok(text) = std::fs::read_to_string(&path) else {
            // Not UTF-8 text — skip rather than fail the whole run.
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        let doc_id = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.display().to_string());
        let result = chunk_for_rag(&text, &config).with_context(|| format!("failed to chunk {}", path.display()))?;
        let chunks: Vec<ChunkInput> = result
            .chunks
            .into_iter()
            .filter(|c| !c.content.trim().is_empty())
            .map(|c| ChunkInput { text: c.content, page: None })
            .collect();
        if !chunks.is_empty() {
            docs.push(DocumentInput { doc_id, chunks });
        }
    }
    Ok(docs)
}

/// Resolve `--embedder preset` into a real model-backed embedder. Shared by
/// all three commands so the "load the preset" error path only exists once.
fn preset_embedder(preset: &str) -> Result<xberg::XbergEmbedder> {
    xberg::XbergEmbedder::from_preset(preset).with_context(|| format!("embedding preset {preset:?}"))
}

/// `xberg rag index` — chunk, embed, and index every text file under `input`.
///
/// There is no generic `with_engine` helper here on purpose: `RagEngine<E>` is
/// generic over `Embedder`, so a helper shared across the `mock`/`preset` arms
/// would need either a boxed `dyn` embedder or a `for<E>` closure (not
/// expressible in stable Rust) — machinery only worth it with far more than
/// three call sites. Each command matches on `embedder` directly instead.
pub fn rag_index_command(
    matter: &str,
    input: &Path,
    mirrors_dir: Option<PathBuf>,
    embedder: EmbedderKind,
    preset: &str,
    chunk_size: usize,
) -> Result<()> {
    if !input.exists() {
        bail!("input path not found: {}", input.display());
    }
    let docs = collect_documents(input, chunk_size)?;
    if docs.is_empty() {
        bail!("no indexable text files found under {}", input.display());
    }
    let mirrors_dir = mirrors_root(mirrors_dir);

    let total = match embedder {
        EmbedderKind::Mock => {
            RagEngine::new(xberg_rag::MockEmbedder::new(64), mirrors_dir).index_documents(matter, &docs)?
        }
        EmbedderKind::Preset => RagEngine::new(preset_embedder(preset)?, mirrors_dir).index_documents(matter, &docs)?,
    };
    println!("indexed {} document(s); matter {matter} now holds {total} chunk(s)", docs.len());
    Ok(())
}

/// `xberg rag query` — live similarity search over the matter's actual vectors.
pub fn rag_query_command(
    matter: &str,
    text: &str,
    top_k: usize,
    mirrors_dir: Option<PathBuf>,
    embedder: EmbedderKind,
    preset: &str,
    json: bool,
) -> Result<()> {
    let mirrors_dir = mirrors_root(mirrors_dir);

    let hits = match embedder {
        EmbedderKind::Mock => RagEngine::new(xberg_rag::MockEmbedder::new(64), mirrors_dir).query(matter, text, top_k)?,
        EmbedderKind::Preset => RagEngine::new(preset_embedder(preset)?, mirrors_dir).query(matter, text, top_k)?,
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&hits).context("failed to serialize hits")?);
    } else if hits.is_empty() {
        println!("no matches");
    } else {
        for h in &hits {
            println!("{:.4}  {}  {}", h.score, h.citation.as_deref().unwrap_or("-"), h.text);
        }
    }
    Ok(())
}

/// `xberg rag import-legacy` — re-embed a Node-host `bundle.json` into a snapshot.
pub fn rag_import_legacy_command(
    matter: &str,
    mirrors_dir: Option<PathBuf>,
    embedder: EmbedderKind,
    preset: &str,
) -> Result<()> {
    let mirrors_dir = mirrors_root(mirrors_dir);

    let count = match embedder {
        EmbedderKind::Mock => RagEngine::new(xberg_rag::MockEmbedder::new(64), mirrors_dir).import_legacy(matter)?,
        EmbedderKind::Preset => RagEngine::new(preset_embedder(preset)?, mirrors_dir).import_legacy(matter)?,
    };
    println!("imported {count} chunk(s) from the legacy bundle for matter {matter}");
    Ok(())
}
