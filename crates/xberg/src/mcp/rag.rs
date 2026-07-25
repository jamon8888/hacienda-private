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

fn enabled_from_value(value: Option<&str>) -> bool {
    matches!(value, Some("1" | "true" | "TRUE"))
}

/// Whether this host should expose the RAG tool at all.
///
/// Default **off**: `xberg-cli` is distributed on its own (crates.io, the
/// `ghcr.io/xberg-io/xberg-cli` images), and an extraction-focused user has no
/// `~/.xberg/mirrors` — an always-listed `rag_query` would be a tool that only
/// ever errors for them. Opt in with `XBERG_RAG_ENABLED=1`.
pub(crate) fn is_enabled() -> bool {
    enabled_from_value(std::env::var("XBERG_RAG_ENABLED").ok().as_deref())
}

fn preset_from_value(value: Option<String>) -> String {
    value.unwrap_or_else(|| "lightweight".to_string())
}

/// Embedding preset used by the MCP host.
///
/// Defaults to `lightweight` (model2vec, pure Rust) so the server never
/// hard-requires a bundled ONNX Runtime — the spec's R3 mitigation. Override
/// with `XBERG_RAG_PRESET`.
fn preset_name() -> String {
    preset_from_value(std::env::var("XBERG_RAG_PRESET").ok())
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
        RagError::InvalidMatterId { matter_id } => rmcp::ErrorData::invalid_params(
            format!("invalid matter_id {matter_id:?}: must not be empty, '.' or '..'"),
            None,
        ),
        RagError::MatterNotFound(id) => {
            rmcp::ErrorData::invalid_params(format!("no indexed data for matter {id}"), None)
        }
        other => rmcp::ErrorData::internal_error(other.to_string(), None),
    }
}

/// Execute a live RAG query and shape it for MCP structured output.
pub(crate) fn query(params: &super::params::RagQueryParams) -> Result<super::schema::RagQueryOutput, rmcp::ErrorData> {
    if params.matter_id.trim().is_empty() || matches!(params.matter_id.as_str(), "." | "..") {
        return Err(rmcp::ErrorData::invalid_params(
            "matter_id must not be empty, '.' or '..'",
            None,
        ));
    }
    if params.query.trim().is_empty() {
        return Err(rmcp::ErrorData::invalid_params("query must not be empty", None));
    }
    let top_k = params.top_k.unwrap_or(8).clamp(1, 100);

    let engine = build_engine().map_err(to_mcp_error)?;
    let hits = engine
        .query(&params.matter_id, &params.query, top_k)
        .map_err(to_mcp_error)?;

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
    fn path_alias_matter_id_is_rejected_before_loading_the_model() {
        for matter_id in [".", ".."] {
            let err = query(&params(matter_id, "anything")).unwrap_err();
            assert_eq!(err.code.0, -32602);
            assert!(err.message.contains("matter_id"), "got {}", err.message);
        }
    }

    #[test]
    fn empty_query_is_invalid_params() {
        let err = query(&params("m1", "   ")).unwrap_err();
        assert!(err.message.contains("query"), "got {}", err.message);
    }

    #[test]
    fn invalid_matter_id_maps_to_invalid_params() {
        let err = to_mcp_error(RagError::InvalidMatterId {
            matter_id: "..".to_string(),
        });
        assert_eq!(err.code.0, -32602);
        assert!(err.message.contains("matter_id"), "got {}", err.message);
        assert!(err.message.contains(".."), "got {}", err.message);
    }

    #[test]
    fn not_found_maps_to_invalid_params_naming_the_matter() {
        let err = to_mcp_error(RagError::MatterNotFound("missing-matter".to_string()));
        assert_eq!(err.code.0, -32602);
        assert!(err.message.contains("missing-matter"), "got {}", err.message);
    }

    #[test]
    fn enabled_value_parser_is_opt_in() {
        assert!(!enabled_from_value(None));
        assert!(!enabled_from_value(Some("false")));
        assert!(!enabled_from_value(Some("TRUE ")));
        for enabled in ["1", "true", "TRUE"] {
            assert!(enabled_from_value(Some(enabled)), "{enabled} should enable RAG");
        }
    }

    #[test]
    fn preset_value_parser_defaults_only_when_absent() {
        assert_eq!(preset_from_value(None), "lightweight");
        assert_eq!(preset_from_value(Some("balanced".to_string())), "balanced");
    }
}
