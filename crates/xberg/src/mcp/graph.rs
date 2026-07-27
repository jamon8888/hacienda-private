//! MCP-facing wiring for the sealed droit-des-affaires entity graph.
//!
//! PR 4 of 4 for the entity-graph plan (PR 1: crypto/sqlite spikes, PR 2: browser-side
//! extraction + sealing, PR 3: opaque blob storage on both MCP hosts). This tool decrypts the
//! sealed graph, queries it in an ephemeral in-memory `rusqlite` connection, and discards
//! everything at the end of the call — nothing decrypted is ever written to disk.

/// Name of the graph tool, used both by the `#[tool]` attribute and by the route gate in
/// `XbergMcp::with_config`. Keep the two in sync via this constant.
pub(crate) const GRAPH_QUERY_TOOL: &str = "graph_query";

#[cfg(feature = "graph-query")]
fn enabled_from_value(value: Option<&str>) -> bool {
    matches!(value, Some("1" | "true" | "TRUE"))
}

/// Whether this host should expose `graph_query` at all.
///
/// Default **off**, same posture as `rag_query`: opt in with `XBERG_GRAPH_ENABLED=1`. Also
/// unconditionally `false` when this crate wasn't built with the `graph-query` feature — a build
/// that skipped that feature (to avoid rusqlite's `bundled` C-compile cost, e.g. Android/Windows
/// target aggregates) must never advertise a tool it can't actually run.
#[cfg(feature = "graph-query")]
pub(crate) fn is_enabled() -> bool {
    enabled_from_value(std::env::var("XBERG_GRAPH_ENABLED").ok().as_deref())
}

#[cfg(not(feature = "graph-query"))]
pub(crate) fn is_enabled() -> bool {
    false
}

#[cfg(all(test, feature = "graph-query"))]
mod enabled_tests {
    use super::enabled_from_value;

    #[test]
    fn enabled_value_parser_is_opt_in() {
        assert!(!enabled_from_value(None));
        assert!(!enabled_from_value(Some("false")));
        assert!(!enabled_from_value(Some("TRUE ")));
        for enabled in ["1", "true", "TRUE"] {
            assert!(enabled_from_value(Some(enabled)), "{enabled} should enable graph_query");
        }
    }
}

/// Real implementation, compiled only when the `graph-query` Cargo feature (which pulls in
/// `rusqlite`'s `bundled` SQLite C build) is enabled.
#[cfg(feature = "graph-query")]
pub(crate) fn query(
    params: &super::params::GraphQueryParams,
) -> Result<super::schema::GraphQueryOutput, rmcp::ErrorData> {
    imp::query(params)
}

/// Stub compiled when `graph-query` is off: the `#[tool]`-annotated method in `server.rs` calls
/// this unconditionally (it must compile either way — see the module doc on why the tool method
/// itself can't be `#[cfg]`-gated), but the route is always disabled by `is_enabled()` above, so
/// this body is unreachable in practice; it exists only so the crate compiles without the feature.
#[cfg(not(feature = "graph-query"))]
pub(crate) fn query(
    _params: &super::params::GraphQueryParams,
) -> Result<super::schema::GraphQueryOutput, rmcp::ErrorData> {
    Err(rmcp::ErrorData::internal_error(
        "graph_query requires this build to be compiled with the 'graph-query' feature",
        None,
    ))
}

#[cfg(feature = "graph-query")]
mod imp {
    use std::collections::{HashMap, HashSet};

    use rusqlite::{Connection, Result as SqlResult, Row, ToSql, params};

    use crate::text::browser_vault::decrypt_browser_vault;
    use xberg_rag::{MatterPaths, default_mirrors_dir, read_bundle_graph};

    use super::super::errors::map_xberg_error_to_mcp;
    use super::super::params::GraphQueryParams;
    use super::super::schema::{GraphEdgeOutput, GraphNodeOutput, GraphQueryOutput};

    /// One node as sealed by `packages/wasm-pipeline/src/entity-graph.ts`'s `GraphNode` — field
    /// names are the same camelCase the browser's `JSON.stringify` produced.
    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PlainNode {
        id: String,
        r#type: String,
        label: String,
        #[serde(default)]
        #[allow(dead_code)] // not surfaced in output yet; kept so the sealed shape round-trips
        attrs: HashMap<String, String>,
        doc_id: String,
        chunk_index: u32,
    }

    /// One edge as sealed by `GraphEdge`.
    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PlainEdge {
        id: String,
        r#type: String,
        from: String,
        to: String,
        doc_id: String,
        chunk_index: u32,
    }

    #[derive(Debug, serde::Deserialize)]
    struct PlainGraph {
        nodes: Vec<PlainNode>,
        edges: Vec<PlainEdge>,
    }

    fn bad_request(message: impl Into<String>) -> rmcp::ErrorData {
        rmcp::ErrorData::invalid_params(message.into(), None)
    }

    fn internal(message: impl Into<String>) -> rmcp::ErrorData {
        rmcp::ErrorData::internal_error(message.into(), None)
    }

    /// No vectors are involved here (unlike the Step 0 `sqlite-vec` spike) — the entity graph is
    /// a small nodes/edges structure, not a similarity-search corpus, so a plain in-memory
    /// `rusqlite` connection (no extension loading) is all a recursive-CTE traversal needs.
    fn build_graph_db(graph: &PlainGraph) -> SqlResult<Connection> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL,
                                  doc_id TEXT NOT NULL, chunk_index INTEGER NOT NULL);
             CREATE TABLE edges (id TEXT PRIMARY KEY, type TEXT NOT NULL,
                                  from_id TEXT NOT NULL, to_id TEXT NOT NULL,
                                  doc_id TEXT NOT NULL, chunk_index INTEGER NOT NULL);
             CREATE INDEX idx_edges_from ON edges(from_id);
             CREATE INDEX idx_edges_to ON edges(to_id);",
        )?;
        {
            let mut insert_node =
                conn.prepare("INSERT INTO nodes (id, type, label, doc_id, chunk_index) VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for n in &graph.nodes {
                insert_node.execute(params![n.id, n.r#type, n.label, n.doc_id, n.chunk_index])?;
            }
        }
        {
            let mut insert_edge = conn.prepare(
                "INSERT INTO edges (id, type, from_id, to_id, doc_id, chunk_index) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for e in &graph.edges {
                insert_edge.execute(params![e.id, e.r#type, e.from, e.to, e.doc_id, e.chunk_index])?;
            }
        }
        Ok(conn)
    }

    fn node_row(row: &Row) -> SqlResult<GraphNodeOutput> {
        Ok(GraphNodeOutput {
            id: row.get(0)?,
            r#type: row.get(1)?,
            label: row.get(2)?,
            doc_id: row.get(3)?,
            chunk_index: row.get(4)?,
        })
    }

    fn edge_row(row: &Row) -> SqlResult<GraphEdgeOutput> {
        Ok(GraphEdgeOutput {
            id: row.get(0)?,
            r#type: row.get(1)?,
            from: row.get(2)?,
            to: row.get(3)?,
            doc_id: row.get(4)?,
            chunk_index: row.get(5)?,
        })
    }

    /// Traverse from the node whose label exactly matches `from_label` (case-insensitive) out to
    /// `max_hops` edges away, returning every reached node plus the edges connecting them.
    fn traverse(conn: &Connection, from_label: &str, max_hops: u32, limit: i64) -> SqlResult<GraphQueryOutput> {
        let mut stmt = conn.prepare(
            "WITH RECURSIVE reachable(id, hops) AS (
               SELECT id, 0 FROM nodes WHERE lower(label) = lower(?1)
               UNION
               SELECT CASE WHEN e.from_id = r.id THEN e.to_id ELSE e.from_id END, r.hops + 1
               FROM edges e JOIN reachable r ON e.from_id = r.id OR e.to_id = r.id
               WHERE r.hops < ?2
             )
             SELECT DISTINCT n.id, n.type, n.label, n.doc_id, n.chunk_index
             FROM nodes n JOIN reachable r ON r.id = n.id
             LIMIT ?3",
        )?;
        let nodes = stmt
            .query_map(params![from_label, max_hops, limit], node_row)?
            .collect::<SqlResult<Vec<_>>>()?;

        let node_ids: HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
        let mut edge_stmt = conn.prepare("SELECT id, type, from_id, to_id, doc_id, chunk_index FROM edges")?;
        let edges = edge_stmt
            .query_map([], edge_row)?
            .collect::<SqlResult<Vec<_>>>()?
            .into_iter()
            .filter(|e| node_ids.contains(e.from.as_str()) && node_ids.contains(e.to.as_str()))
            .collect();

        Ok(GraphQueryOutput {
            matter_id: String::new(), // filled in by the caller
            nodes,
            edges,
        })
    }

    /// Filter nodes by exact type and/or a case-insensitive label substring. Returns no edges —
    /// a flat filter has no natural "which edges belong to this result set" answer the way a
    /// traversal does, so callers wanting relations use `from_label` instead.
    fn filter(
        conn: &Connection,
        node_type: Option<&str>,
        label_contains: Option<&str>,
        limit: i64,
    ) -> SqlResult<GraphQueryOutput> {
        let mut conditions: Vec<String> = Vec::new();
        let mut sql_params: Vec<Box<dyn ToSql>> = Vec::new();
        if let Some(node_type) = node_type {
            conditions.push(format!("type = ?{}", sql_params.len() + 1));
            sql_params.push(Box::new(node_type.to_string()));
        }
        if let Some(label_contains) = label_contains {
            conditions.push(format!(
                "lower(label) LIKE '%' || lower(?{}) || '%'",
                sql_params.len() + 1
            ));
            sql_params.push(Box::new(label_contains.to_string()));
        }
        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        sql_params.push(Box::new(limit));
        let limit_placeholder = sql_params.len();

        let sql =
            format!("SELECT id, type, label, doc_id, chunk_index FROM nodes {where_clause} LIMIT ?{limit_placeholder}");
        let mut stmt = conn.prepare(&sql)?;
        let params_ref: Vec<&dyn ToSql> = sql_params.iter().map(|b| b.as_ref()).collect();
        let nodes = stmt
            .query_map(params_ref.as_slice(), node_row)?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(GraphQueryOutput {
            matter_id: String::new(),
            nodes,
            edges: Vec::new(),
        })
    }

    pub(crate) fn query(params: &GraphQueryParams) -> Result<GraphQueryOutput, rmcp::ErrorData> {
        if params.matter_id.trim().is_empty() || matches!(params.matter_id.as_str(), "." | "..") {
            return Err(bad_request("matter_id must not be empty, '.' or '..'"));
        }
        if params.passphrase.is_empty() {
            return Err(bad_request("passphrase must not be empty"));
        }

        let paths =
            MatterPaths::new(&default_mirrors_dir(), &params.matter_id).map_err(|e| bad_request(e.to_string()))?;
        let bytes = std::fs::read(paths.legacy_bundle())
            .map_err(|_| bad_request(format!("no mirror found for matter {}", params.matter_id)))?;

        let sealed = read_bundle_graph(&bytes)
            .map_err(|e| internal(e.to_string()))?
            .ok_or_else(|| {
                bad_request(format!(
                    "matter {} has no entity graph — entityGraphLabels must be set at ingest time",
                    params.matter_id
                ))
            })?;

        let plaintext =
            decrypt_browser_vault(&sealed.cipher, &sealed.salt, &params.passphrase).map_err(map_xberg_error_to_mcp)?;

        let graph: PlainGraph = serde_json::from_slice(&plaintext)
            .map_err(|e| internal(format!("sealed entity graph payload is not valid JSON: {e}")))?;

        let conn = build_graph_db(&graph).map_err(|e| internal(format!("in-memory graph store error: {e}")))?;
        let limit = params.limit.unwrap_or(50).clamp(1, 500) as i64;

        let mut result = if let Some(from_label) = params.from_label.as_deref() {
            let max_hops = params.max_hops.unwrap_or(2).clamp(1, 6);
            traverse(&conn, from_label, max_hops, limit)
        } else {
            filter(
                &conn,
                params.node_type.as_deref(),
                params.label_contains.as_deref(),
                limit,
            )
        }
        .map_err(|e| internal(format!("graph query failed: {e}")))?;
        // `conn` (and the decrypted `graph`/`plaintext` it was built from) is dropped at the end
        // of this function — the sealed blob is decrypted, queried, and discarded, never written
        // to disk in decrypted form.

        result.matter_id = params.matter_id.clone();
        Ok(result)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn sample_graph() -> PlainGraph {
            serde_json::from_value(serde_json::json!({
                "nodes": [
                    { "id": "n1", "type": "dirigeant", "label": "Jean Dupont", "attrs": {}, "docId": "d1", "chunkIndex": 0 },
                    { "id": "n2", "type": "societe", "label": "SASU Dupont Conseil", "attrs": {}, "docId": "d1", "chunkIndex": 0 },
                    { "id": "n3", "type": "actionnaire", "label": "Marie Martin", "attrs": {}, "docId": "d1", "chunkIndex": 1 }
                ],
                "edges": [
                    { "id": "e1", "type": "dirige", "from": "n1", "to": "n2", "docId": "d1", "chunkIndex": 0 },
                    { "id": "e2", "type": "detient", "from": "n3", "to": "n2", "docId": "d1", "chunkIndex": 1 }
                ]
            }))
            .unwrap()
        }

        fn params(matter_id: &str, passphrase: &str) -> GraphQueryParams {
            GraphQueryParams {
                matter_id: matter_id.to_string(),
                passphrase: passphrase.to_string(),
                node_type: None,
                label_contains: None,
                from_label: None,
                max_hops: None,
                limit: None,
            }
        }

        #[test]
        fn empty_matter_id_is_invalid_params() {
            let err = query(&params("  ", "secret")).unwrap_err();
            assert!(err.message.contains("matter_id"), "got {}", err.message);
        }

        #[test]
        fn empty_passphrase_is_invalid_params() {
            let err = query(&params("m1", "")).unwrap_err();
            assert!(err.message.contains("passphrase"), "got {}", err.message);
        }

        #[test]
        fn missing_mirror_is_invalid_params() {
            let err = query(&params("matter-with-no-mirror-at-all", "secret")).unwrap_err();
            assert!(err.message.contains("no mirror"), "got {}", err.message);
        }

        #[test]
        fn build_graph_db_round_trips_nodes_and_edges() {
            let graph = sample_graph();
            let conn = build_graph_db(&graph).unwrap();
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get(0)).unwrap();
            assert_eq!(count, 3);
            let count: i64 = conn.query_row("SELECT COUNT(*) FROM edges", [], |r| r.get(0)).unwrap();
            assert_eq!(count, 2);
        }

        #[test]
        fn filter_by_node_type() {
            let conn = build_graph_db(&sample_graph()).unwrap();
            let result = filter(&conn, Some("societe"), None, 50).unwrap();
            assert_eq!(result.nodes.len(), 1);
            assert_eq!(result.nodes[0].label, "SASU Dupont Conseil");
            assert!(result.edges.is_empty());
        }

        #[test]
        fn filter_by_label_substring_is_case_insensitive() {
            let conn = build_graph_db(&sample_graph()).unwrap();
            let result = filter(&conn, None, Some("dupont"), 50).unwrap();
            let labels: Vec<&str> = result.nodes.iter().map(|n| n.label.as_str()).collect();
            assert!(labels.contains(&"Jean Dupont"));
            assert!(labels.contains(&"SASU Dupont Conseil"));
            assert_eq!(labels.len(), 2);
        }

        #[test]
        fn traverse_one_hop_from_the_company_reaches_both_the_director_and_the_shareholder() {
            let conn = build_graph_db(&sample_graph()).unwrap();
            let result = traverse(&conn, "SASU Dupont Conseil", 1, 50).unwrap();
            let labels: HashSet<&str> = result.nodes.iter().map(|n| n.label.as_str()).collect();
            assert!(labels.contains(&"SASU Dupont Conseil"));
            assert!(labels.contains(&"Jean Dupont"));
            assert!(labels.contains(&"Marie Martin"));
            assert_eq!(result.edges.len(), 2);
        }

        #[test]
        fn traverse_zero_distance_reaches_only_the_start_node_at_the_minimum_max_hops() {
            let conn = build_graph_db(&sample_graph()).unwrap();
            // max_hops is clamped to >= 1 by the caller, but the traversal itself should still
            // behave sanely at the smallest allowed depth: reaches direct neighbors only.
            let result = traverse(&conn, "Jean Dupont", 1, 50).unwrap();
            let labels: HashSet<&str> = result.nodes.iter().map(|n| n.label.as_str()).collect();
            assert!(labels.contains(&"Jean Dupont"));
            assert!(labels.contains(&"SASU Dupont Conseil"));
            assert!(!labels.contains(&"Marie Martin"), "Marie Martin is 2 hops away, not 1");
        }

        #[test]
        fn traverse_unknown_label_reaches_nothing() {
            let conn = build_graph_db(&sample_graph()).unwrap();
            let result = traverse(&conn, "Nobody Here", 3, 50).unwrap();
            assert!(result.nodes.is_empty());
            assert!(result.edges.is_empty());
        }
    }
}
