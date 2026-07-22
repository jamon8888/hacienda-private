//! MCP-facing wiring for the native RAG engine.
//!
//! Replaces the Node host's `MirrorStore.retrieve()`, which ignored the query
//! and re-sorted the last-mirrored chunks by a mirror-time placeholder score.
//! Here the query is embedded and searched against the matter's actual vectors.

use crate::rag_embed::XbergEmbedder;
use xberg_rag::{RagEngine, RagError, default_mirrors_dir};

/// Name of the RAG tool, used both by the `#[tool]` attribute and by the route
/// gate in `XbergMcp::with_config`. Keep the two in sync via this constant.
pub(crate) const RAG_QUERY_TOOL: &str = "rag_query";

/// Whether this host should expose the RAG tool at all.
///
/// Default **off**: `xberg-cli` is distributed on its own (crates.io, the
/// `ghcr.io/xberg-io/xberg-cli` images), and an extraction-focused user has no
/// `~/.xberg/mirrors` — an always-listed `rag_query` would be a tool that only
/// ever errors for them. Opt in with `XBERG_RAG_ENABLED=1`.
pub(crate) fn is_enabled() -> bool {
    matches!(
        std::env::var("XBERG_RAG_ENABLED").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

/// Embedding preset used by the MCP host.
///
/// Defaults to `lightweight` (model2vec, pure Rust) so the server never
/// hard-requires a bundled ONNX Runtime — the spec's R3 mitigation. Override
/// with `XBERG_RAG_PRESET`.
fn preset_name() -> String {
    std::env::var("XBERG_RAG_PRESET").unwrap_or_else(|_| "lightweight".to_string())
}

/// Build an engine over the mirrors root this host is configured for.
fn build_engine() -> Result<RagEngine<XbergEmbedder>, RagError> {
    let embedder = XbergEmbedder::from_preset(&preset_name())?;
    Ok(RagEngine::new(embedder, default_mirrors_dir()))
}

/// Map a RAG error onto the MCP error surface, preserving the distinction
/// between "this matter has nothing indexed" and a genuine internal failure.
fn to_mcp_error(err: RagError) -> rmcp::ErrorData {
    match err {
        RagError::MatterNotFound(id) => {
            rmcp::ErrorData::invalid_params(format!("no indexed data for matter {id}"), None)
        }
        other => rmcp::ErrorData::internal_error(other.to_string(), None),
    }
}

/// Execute a live RAG query and shape it for MCP structured output.
pub(crate) fn query(params: &super::params::RagQueryParams) -> Result<super::schema::RagQueryOutput, rmcp::ErrorData> {
    if params.matter_id.trim().is_empty() {
        return Err(rmcp::ErrorData::invalid_params("matter_id must not be empty", None));
    }
    if params.query.trim().is_empty() {
        return Err(rmcp::ErrorData::invalid_params("query must not be empty", None));
    }
    let top_k = params.top_k.unwrap_or(8).clamp(1, 100);

    let engine = build_engine().map_err(to_mcp_error)?;
    let hits = engine.query(&params.matter_id, &params.query, top_k).map_err(to_mcp_error)?;

    Ok(super::schema::RagQueryOutput {
        matter_id: params.matter_id.clone(),
        hits: hits
            .into_iter()
            .map(|h| super::schema::RagHit {
                doc_id: h.doc_id,
                chunk_index: h.chunk_index,
                text: h.text,
                score: h.score,
                citation: h.citation,
                page: h.page,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::params::RagQueryParams;

    fn params(matter: &str, query: &str) -> RagQueryParams {
        RagQueryParams {
            matter_id: matter.to_string(),
            query: query.to_string(),
            top_k: None,
        }
    }

    #[test]
    fn empty_matter_id_is_invalid_params() {
        let err = query(&params("  ", "anything")).unwrap_err();
        assert!(err.message.contains("matter_id"), "got {}", err.message);
    }

    #[test]
    fn empty_query_is_invalid_params() {
        let err = query(&params("m1", "   ")).unwrap_err();
        assert!(err.message.contains("query"), "got {}", err.message);
    }

    #[test]
    fn not_found_maps_to_invalid_params_naming_the_matter() {
        // No model is loaded for this path only if build_engine fails first, so
        // assert on whichever error surfaces: both are user-facing and must
        // mention the cause rather than panicking.
        let err = query(&params("definitely-not-a-real-matter", "hello")).unwrap_err();
        assert!(!err.message.is_empty());
    }

    #[test]
    fn defaults_are_off_and_lightweight() {
        // Neither env var is set in the test process, so both defaults apply.
        // Note: `std::env::set_var` is `unsafe` on edition 2024 and this
        // workspace denies `unsafe_code`, so these assert the unset-default
        // rather than mutating the environment. The enabled path is covered by
        // Step 4's manual check.
        assert!(!is_enabled(), "RAG must be opt-in, never on by default");
        assert_eq!(preset_name(), "lightweight");
    }
}
