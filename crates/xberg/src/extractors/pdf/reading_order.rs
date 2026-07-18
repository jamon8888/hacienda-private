//! Layout-guided PDF reading-order reconstruction.
//!
//! When enabled, this module projects text spans onto layout-detected regions,
//! performs column detection, and reorders spans in natural reading order
//! (top-to-bottom within a column, left-to-right across columns).
//!
//! This is critical for multi-column academic PDFs where native PDF text
//! extraction reads in column order rather than visual reading order.

#[cfg(feature = "layout-detection")]
use crate::pdf::structure::types::LayoutHint;

/// Region x-centers closer than this (in PDF points) are merged into one column.
const COLUMN_MERGE_THRESHOLD_PTS: f32 = 20.0;

/// A text span with bounding box information.
#[derive(Debug, Clone)]
pub struct TextSpan {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Detect columns by clustering region x-centers.
///
/// Analyzes the horizontal positions of regions (using their x-centers) to
/// identify distinct columns. Uses k-means-like clustering with a distance
/// threshold to group regions that belong to the same column.
///
/// Returns a Vec of column assignments, one per region, mapping region index
/// to column ID (0 = leftmost column).
fn detect_columns(regions: &[RegionProjection]) -> Vec<usize> {
    if regions.is_empty() {
        return Vec::new();
    }

    let mut x_centers: Vec<f32> = regions.iter().map(|r| (r.left + r.right) / 2.0).collect();

    x_centers.sort_by(|a, b| a.total_cmp(b));

    let mut unique_centers: Vec<f32> = Vec::new();
    let merge_threshold: f32 = COLUMN_MERGE_THRESHOLD_PTS;

    for &center in &x_centers {
        if let Some(&last) = unique_centers.last() {
            if (center - last).abs() > merge_threshold {
                unique_centers.push(center);
            }
        } else {
            unique_centers.push(center);
        }
    }

    let mut assignments = vec![0usize; regions.len()];
    for (i, region) in regions.iter().enumerate() {
        let center = (region.left + region.right) / 2.0;
        let mut best_col = 0;
        let mut best_dist = f32::INFINITY;

        for (col_id, &cluster_center) in unique_centers.iter().enumerate() {
            let dist = (center - cluster_center).abs();
            if dist < best_dist {
                best_dist = dist;
                best_col = col_id;
            }
        }

        assignments[i] = best_col;
    }

    assignments
}

/// A region projection: layout region with indices of spans it contains.
#[derive(Debug, Clone)]
struct RegionProjection {
    left: f32,
    bottom: f32,
    right: f32,
    top: f32,
    span_indices: Vec<usize>,
}

/// Project spans onto regions using bounding box intersection/containment.
///
/// For each span, determines which region(s) it overlaps with using a simple
/// containment heuristic: if the span's center is within the region, the span
/// belongs to that region.
fn project_spans_to_regions(spans: &[TextSpan], hints: &[LayoutHint]) -> Vec<RegionProjection> {
    let mut regions: Vec<RegionProjection> = hints
        .iter()
        .map(|hint| RegionProjection {
            left: hint.left,
            bottom: hint.bottom,
            right: hint.right,
            top: hint.top,
            span_indices: Vec::new(),
        })
        .collect();

    for (span_idx, span) in spans.iter().enumerate() {
        let span_center_x = span.x + span.width / 2.0;
        let span_center_y = span.y + span.height / 2.0;

        let mut best_region = None;
        let mut best_overlap = 0.0;

        for (region_idx, region) in regions.iter().enumerate() {
            if span_center_x >= region.left
                && span_center_x <= region.right
                && span_center_y >= region.bottom
                && span_center_y <= region.top
            {
                let area = (region.right - region.left) * (region.top - region.bottom);
                if best_region.is_none() || area < best_overlap {
                    best_region = Some(region_idx);
                    best_overlap = area;
                }
            }
        }

        if let Some(region_idx) = best_region {
            regions[region_idx].span_indices.push(span_idx);
        }
    }

    regions.retain(|r| !r.span_indices.is_empty());
    regions
}

/// Tolerance mirroring Docling's `eps` in its bounding-box predicates.
#[cfg(feature = "layout-detection")]
const READING_ORDER_EPS: f32 = 1e-3;

/// A layout block (bbox in PDF points, bottom-left origin) used by the
/// predecessor-graph reading-order reconstruction.
#[cfg(feature = "layout-detection")]
#[derive(Debug, Clone, Copy)]
struct OrderBlock {
    left: f32,
    bottom: f32,
    right: f32,
    top: f32,
}

#[cfg(feature = "layout-detection")]
impl OrderBlock {
    /// `self` lies entirely above `other` (bottom-left origin: larger y is higher).
    ///
    /// Port of docling-core `BoundingBox::is_strictly_above` for BOTTOMLEFT origin.
    fn is_strictly_above(&self, other: &OrderBlock) -> bool {
        (self.bottom + READING_ORDER_EPS) > other.top
    }

    /// The two blocks' x-ranges overlap. Strict: touching edges do not count.
    ///
    /// Port of docling-core `BoundingBox::overlaps_horizontally`.
    fn overlaps_horizontally(&self, other: &OrderBlock) -> bool {
        !(self.right <= other.left || other.right <= self.left)
    }
}

/// Reading-order comparator (`Ordering::Less` == `a` precedes `b`).
///
/// Port of docling `PageElement.__lt__`: same-column (horizontally overlapping)
/// blocks order top-to-bottom (higher bottom edge first); otherwise
/// left-to-right (smaller left edge first).
#[cfg(feature = "layout-detection")]
fn reading_order_cmp(a: &OrderBlock, b: &OrderBlock) -> std::cmp::Ordering {
    if a.overlaps_horizontally(b) {
        b.bottom.total_cmp(&a.bottom)
    } else {
        a.left.total_cmp(&b.left)
    }
}

/// Is there a block strictly between `i` and `j` that horizontally overlaps
/// either, interrupting the `i → j` reading-order edge?
///
/// Port of docling `_has_sequence_interruption`. This is what stops a full-width
/// heading or figure sitting between two columns from chaining blocks across them.
#[cfg(feature = "layout-detection")]
fn has_sequence_interruption(blocks: &[OrderBlock], i: usize, j: usize) -> bool {
    let bi = &blocks[i];
    let bj = &blocks[j];
    blocks.iter().enumerate().any(|(w, bw)| {
        w != i
            && w != j
            && (bi.overlaps_horizontally(bw) || bj.overlaps_horizontally(bw))
            && bi.is_strictly_above(bw)
            && bw.is_strictly_above(bj)
    })
}

/// Build the up/down predecessor maps over `blocks`.
///
/// Port of docling `_init_ud_maps`: an edge `i → j` exists when `i` is strictly
/// above `j`, they horizontally overlap, and no third block interrupts the pair.
/// `up[j]` collects predecessors of `j`; `dn[i]` collects successors of `i`.
#[cfg(feature = "layout-detection")]
fn build_updown_maps(blocks: &[OrderBlock]) -> (Vec<Vec<usize>>, Vec<Vec<usize>>) {
    let n = blocks.len();
    let mut up = vec![Vec::new(); n];
    let mut dn = vec![Vec::new(); n];
    for i in 0..n {
        for j in 0..n {
            if i != j
                && blocks[i].is_strictly_above(&blocks[j])
                && blocks[i].overlaps_horizontally(&blocks[j])
                && !has_sequence_interruption(blocks, i, j)
            {
                dn[i].push(j);
                up[j].push(i);
            }
        }
    }
    (up, dn)
}

/// Walk up the predecessor map from `start`, always taking the first not-yet-
/// visited predecessor, until reaching a block whose predecessors are all
/// visited. Guarantees every predecessor is emitted before its successor.
///
/// Port of docling `_depth_first_search_upwards` (iterative).
#[cfg(feature = "layout-detection")]
fn walk_to_unvisited_root(start: usize, up: &[Vec<usize>], visited: &[bool]) -> usize {
    let mut k = start;
    loop {
        match up[k].iter().copied().find(|&p| !visited[p]) {
            Some(p) => k = p,
            None => return k,
        }
    }
}

/// Emit `start`'s successor subtree in reading order.
///
/// Port of docling `_depth_first_search_downwards` (iterative, explicit stack).
#[cfg(feature = "layout-detection")]
fn emit_downwards(start: usize, order: &mut Vec<usize>, visited: &mut [bool], up: &[Vec<usize>], dn: &[Vec<usize>]) {
    let mut stack: Vec<(usize, usize)> = vec![(start, 0)];
    while let Some(&(node, offset)) = stack.last() {
        let mut next = offset;
        let mut advanced = false;
        while next < dn[node].len() {
            let child = dn[node][next];
            let root = walk_to_unvisited_root(child, up, visited);
            if !visited[root] {
                order.push(root);
                visited[root] = true;
                let top = stack.len() - 1;
                stack[top].1 = next + 1;
                stack.push((root, 0));
                advanced = true;
                break;
            }
            next += 1;
        }
        if !advanced {
            stack.pop();
        }
    }
}

/// Whether the page is genuinely multi-column: two content blocks sit side by
/// side (their y-ranges overlap while their x-ranges do not).
///
/// Reading-order reorder only helps multi-column pages — single-column stream
/// order already reads top-to-bottom, so reordering it by (often noisy) layout
/// regions is pure downside. This is the defining geometric signal of columns.
#[cfg(feature = "layout-detection")]
fn is_multi_column(blocks: &[OrderBlock]) -> bool {
    for (i, a) in blocks.iter().enumerate() {
        for b in &blocks[i + 1..] {
            let vertical_overlap = !(a.top <= b.bottom || b.top <= a.bottom);
            if vertical_overlap && !a.overlaps_horizontally(b) {
                return true;
            }
        }
    }
    false
}

/// Order `blocks` (layout regions with content) in reading order via the
/// predecessor graph. Returns block indices in reading order.
///
/// Port of docling `ReadingOrderPredictor._predict_page`, sans the horizontal
/// dilation refinement (`_do_horizontal_dilation`), which is a follow-up.
#[cfg(feature = "layout-detection")]
fn order_blocks_by_graph(blocks: &[OrderBlock]) -> Vec<usize> {
    let n = blocks.len();
    let (up, mut dn) = build_updown_maps(blocks);

    // Sort each node's successors by the reading-order comparator.
    for children in dn.iter_mut() {
        children.sort_by(|&a, &b| reading_order_cmp(&blocks[a], &blocks[b]));
    }

    // Heads: blocks with no predecessor, in reading order.
    let mut heads: Vec<usize> = (0..n).filter(|&k| up[k].is_empty()).collect();
    heads.sort_by(|&a, &b| reading_order_cmp(&blocks[a], &blocks[b]));

    let mut visited = vec![false; n];
    let mut order = Vec::with_capacity(n);
    for &head in &heads {
        if !visited[head] {
            order.push(head);
            visited[head] = true;
            emit_downwards(head, &mut order, &mut visited, &up, &dn);
        }
    }
    // Safety net: append any block the traversal missed (degenerate geometry /
    // cycles) so no content is dropped.
    for (k, &seen) in visited.iter().enumerate() {
        if !seen {
            order.push(k);
        }
    }
    order
}

/// Reorder page segments into natural reading order using layout regions.
///
/// Groups segments into their smallest containing layout region, orders those
/// regions with Docling's rule-based predecessor-graph reading-order algorithm
/// ([`order_blocks_by_graph`]), then emits each region's segments top-to-bottom.
/// Segments outside every region keep their original relative position at the end.
///
/// This handles multi-column layouts correctly: the predecessor graph plus its
/// interruption veto keep column flow intact and let a full-width heading break
/// the chain between columns — where a naive column sort cannot.
#[cfg(feature = "layout-detection")]
pub(crate) fn reorder_segments_by_layout(
    segments: Vec<crate::pdf::hierarchy::SegmentData>,
    hints: &[LayoutHint],
) -> Vec<crate::pdf::hierarchy::SegmentData> {
    if segments.is_empty() || hints.is_empty() {
        return segments;
    }

    if crate::pdf::structure::layout_debug::layout_debug_flags().no_reorder {
        return segments;
    }

    // Bucket each segment into the smallest layout region containing its center.
    let mut region_segments: Vec<Vec<usize>> = vec![Vec::new(); hints.len()];
    for (seg_idx, seg) in segments.iter().enumerate() {
        let center_x = seg.x + seg.width / 2.0;
        let center_y = seg.y + seg.height / 2.0;
        let mut best_region = None;
        let mut best_area = f32::INFINITY;
        for (region_idx, hint) in hints.iter().enumerate() {
            if center_x >= hint.left && center_x <= hint.right && center_y >= hint.bottom && center_y <= hint.top {
                let area = (hint.right - hint.left) * (hint.top - hint.bottom);
                if area < best_area {
                    best_region = Some(region_idx);
                    best_area = area;
                }
            }
        }
        if let Some(region_idx) = best_region {
            region_segments[region_idx].push(seg_idx);
        }
    }

    // Only regions that actually received segments participate in ordering.
    let active: Vec<usize> = (0..hints.len()).filter(|&r| !region_segments[r].is_empty()).collect();
    if active.is_empty() {
        return segments;
    }

    let blocks: Vec<OrderBlock> = active
        .iter()
        .map(|&r| OrderBlock {
            left: hints[r].left,
            bottom: hints[r].bottom,
            right: hints[r].right,
            top: hints[r].top,
        })
        .collect();

    // The predecessor graph pays off only on genuinely multi-column pages. On
    // single-column pages it can fragment an already-correct order when regions
    // are imperfect, so fall back to a plain top-to-bottom block order there
    // (neutral vs raw stream order, but still applies the intra-region sort).
    let block_order = if is_multi_column(&blocks) {
        order_blocks_by_graph(&blocks)
    } else {
        let mut order: Vec<usize> = (0..blocks.len()).collect();
        order.sort_by(|&a, &b| blocks[b].top.total_cmp(&blocks[a].top));
        order
    };

    let mut included = vec![false; segments.len()];
    let mut reorder_map: Vec<usize> = Vec::with_capacity(segments.len());
    for &block_idx in &block_order {
        let region_idx = active[block_idx];
        let mut region: Vec<usize> = region_segments[region_idx].clone();
        // Intra-region: top-to-bottom, then left-to-right.
        region.sort_by(|&a, &b| {
            let top_a = segments[a].y + segments[a].height;
            let top_b = segments[b].y + segments[b].height;
            top_b
                .total_cmp(&top_a)
                .then_with(|| segments[a].x.total_cmp(&segments[b].x))
        });
        for seg_idx in region {
            if !included[seg_idx] {
                included[seg_idx] = true;
                reorder_map.push(seg_idx);
            }
        }
    }
    // Segments outside every region keep their original relative order at the tail.
    for (seg_idx, &done) in included.iter().enumerate() {
        if !done {
            reorder_map.push(seg_idx);
        }
    }

    reorder_map.into_iter().map(|idx| segments[idx].clone()).collect()
}

/// Reorder spans using purely geometric column detection (no layout hints needed).
///
/// Detects columns by clustering span x-centers, then orders spans
/// left-to-right across columns, and top-to-bottom within each column.
///
/// Returns a Vec of span indices in reading order.
fn reorder_spans_geometric(spans: &[TextSpan]) -> Vec<usize> {
    if spans.is_empty() {
        return Vec::new();
    }

    let mut x_centers: Vec<f32> = spans.iter().map(|s| s.x + s.width / 2.0).collect();
    x_centers.sort_by(|a, b| a.total_cmp(b));

    let mut unique_centers: Vec<f32> = Vec::new();
    for &center in &x_centers {
        if let Some(&last) = unique_centers.last() {
            if (center - last).abs() > COLUMN_MERGE_THRESHOLD_PTS {
                unique_centers.push(center);
            }
        } else {
            unique_centers.push(center);
        }
    }

    let mut span_columns: Vec<(usize, f32, usize)> = Vec::new();
    for (span_idx, span) in spans.iter().enumerate() {
        let span_center = span.x + span.width / 2.0;
        let mut best_col = 0;
        let mut best_dist = f32::INFINITY;

        for (col_id, &cluster_center) in unique_centers.iter().enumerate() {
            let dist = (span_center - cluster_center).abs();
            if dist < best_dist {
                best_dist = dist;
                best_col = col_id;
            }
        }

        let top_y = span.y + span.height;
        span_columns.push((best_col, top_y, span_idx));
    }

    span_columns.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.total_cmp(&a.1)));

    span_columns.into_iter().map(|(_, _, idx)| idx).collect()
}

/// Reorder spans based on layout regions and column detection.
///
/// Given a set of spans with bounding boxes and layout-detected regions:
/// 1. Project spans onto regions
/// 2. Detect columns from region x-centers
/// 3. Sort regions by (column_id, top-to-bottom within column)
/// 4. Emit spans in the order of their sorted regions
///
/// When layout hints are unavailable, falls back to geometric column detection.
///
/// Returns a Vec of span indices in reading order.
pub(crate) fn reorder_spans_by_layout(spans: &[TextSpan], hints: &[LayoutHint]) -> Vec<usize> {
    if spans.is_empty() {
        return Vec::new();
    }

    if hints.is_empty() {
        return reorder_spans_geometric(spans);
    }

    let regions = project_spans_to_regions(spans, hints);
    if regions.is_empty() {
        return (0..spans.len()).collect();
    }

    let column_assignments = detect_columns(&regions);

    let mut sorted_regions: Vec<(usize, f32, usize)> = regions
        .iter()
        .enumerate()
        .map(|(region_idx, region)| {
            let col_id = column_assignments[region_idx];
            let top_y = region.top;
            (col_id, top_y, region_idx)
        })
        .collect();

    sorted_regions.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.total_cmp(&a.1)));

    let mut result = Vec::new();
    let mut projected_spans = std::collections::HashSet::new();

    for (_, _, region_idx) in sorted_regions {
        let mut sorted_span_indices: Vec<usize> = regions[region_idx].span_indices.clone();
        sorted_span_indices.sort_by(|&a, &b| {
            let span_a = &spans[a];
            let span_b = &spans[b];
            let top_a = span_a.y + span_a.height;
            let top_b = span_b.y + span_b.height;
            top_b.total_cmp(&top_a).then_with(|| span_a.x.total_cmp(&span_b.x))
        });

        for &span_idx in &sorted_span_indices {
            result.push(span_idx);
            projected_spans.insert(span_idx);
        }
    }

    for span_idx in 0..spans.len() {
        if !projected_spans.contains(&span_idx) {
            result.push(span_idx);
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_columns_two_column_layout() {
        let regions = vec![
            RegionProjection {
                left: 100.0,
                bottom: 100.0,
                right: 200.0,
                top: 500.0,
                span_indices: vec![],
            },
            RegionProjection {
                left: 400.0,
                bottom: 100.0,
                right: 500.0,
                top: 500.0,
                span_indices: vec![],
            },
        ];

        let assignments = detect_columns(&regions);
        assert_eq!(assignments.len(), 2);
        assert_ne!(assignments[0], assignments[1]);
        assert_eq!(assignments[0], 0);
        assert_eq!(assignments[1], 1);
    }

    #[test]
    fn test_project_spans_to_regions() {
        let spans = vec![
            TextSpan {
                text: "Left column".to_string(),
                x: 110.0,
                y: 450.0,
                width: 70.0,
                height: 12.0,
            },
            TextSpan {
                text: "Right column".to_string(),
                x: 410.0,
                y: 450.0,
                width: 75.0,
                height: 12.0,
            },
        ];

        let hints = vec![
            LayoutHint {
                class_name: crate::pdf::structure::types::LayoutHintClass::Text,
                confidence: 0.95,
                left: 100.0,
                bottom: 100.0,
                right: 200.0,
                top: 500.0,
            },
            LayoutHint {
                class_name: crate::pdf::structure::types::LayoutHintClass::Text,
                confidence: 0.95,
                left: 400.0,
                bottom: 100.0,
                right: 500.0,
                top: 500.0,
            },
        ];

        let regions = project_spans_to_regions(&spans, &hints);
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].span_indices.len(), 1);
        assert_eq!(regions[0].span_indices[0], 0);
        assert_eq!(regions[1].span_indices.len(), 1);
        assert_eq!(regions[1].span_indices[0], 1);
    }

    #[test]
    fn test_reorder_spans_two_column_layout() {
        let spans = vec![
            TextSpan {
                text: "A".to_string(),
                x: 110.0,
                y: 450.0,
                width: 10.0,
                height: 12.0,
            },
            TextSpan {
                text: "B".to_string(),
                x: 110.0,
                y: 200.0,
                width: 10.0,
                height: 12.0,
            },
            TextSpan {
                text: "C".to_string(),
                x: 410.0,
                y: 450.0,
                width: 10.0,
                height: 12.0,
            },
            TextSpan {
                text: "D".to_string(),
                x: 410.0,
                y: 200.0,
                width: 10.0,
                height: 12.0,
            },
        ];

        let hints = vec![
            LayoutHint {
                class_name: crate::pdf::structure::types::LayoutHintClass::Text,
                confidence: 0.95,
                left: 100.0,
                bottom: 100.0,
                right: 200.0,
                top: 500.0,
            },
            LayoutHint {
                class_name: crate::pdf::structure::types::LayoutHintClass::Text,
                confidence: 0.95,
                left: 400.0,
                bottom: 100.0,
                right: 500.0,
                top: 500.0,
            },
        ];

        let order = reorder_spans_by_layout(&spans, &hints);
        assert_eq!(order.len(), 4);
        assert_eq!(order[0], 0);
        assert_eq!(order[1], 1);
        assert_eq!(order[2], 2);
        assert_eq!(order[3], 3);
    }

    /// Segment-level reorder must produce true column-major reading order from
    /// interleaved input, independent of the layout-hint ordering. The hints
    /// here are supplied right-column-first; a correct reorder still yields
    /// A, B, C, D (left column top-to-bottom, then right column). A previous
    /// implementation emitted segments in raw hint order and would yield
    /// C, D, A, B here — this is the regression guard.
    #[test]
    fn test_reorder_segments_two_column_independent_of_hint_order() {
        fn seg(text: &str, x: f32, y: f32) -> crate::pdf::hierarchy::SegmentData {
            crate::pdf::hierarchy::SegmentData {
                text: text.to_string(),
                x,
                y,
                width: 10.0,
                height: 12.0,
                font_size: 10.0,
                is_bold: false,
                is_italic: false,
                is_monospace: false,
                baseline_y: y,
                assigned_role: None,
            }
        }

        let segments = vec![
            seg("A", 110.0, 450.0),
            seg("C", 410.0, 450.0),
            seg("B", 110.0, 200.0),
            seg("D", 410.0, 200.0),
        ];

        let hints = vec![
            LayoutHint {
                class_name: crate::pdf::structure::types::LayoutHintClass::Text,
                confidence: 0.95,
                left: 400.0,
                bottom: 100.0,
                right: 500.0,
                top: 500.0,
            },
            LayoutHint {
                class_name: crate::pdf::structure::types::LayoutHintClass::Text,
                confidence: 0.95,
                left: 100.0,
                bottom: 100.0,
                right: 200.0,
                top: 500.0,
            },
        ];

        let reordered = reorder_segments_by_layout(segments, &hints);
        let order: Vec<&str> = reordered.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(
            order,
            vec!["A", "B", "C", "D"],
            "segments must be reordered column-major top-to-bottom regardless of hint order"
        );
    }

    #[test]
    fn test_reorder_segments_full_width_heading_breaks_columns() {
        fn seg(text: &str, x: f32, y: f32) -> crate::pdf::hierarchy::SegmentData {
            crate::pdf::hierarchy::SegmentData {
                text: text.to_string(),
                x,
                y,
                width: 10.0,
                height: 12.0,
                font_size: 10.0,
                is_bold: false,
                is_italic: false,
                is_monospace: false,
                baseline_y: y,
                assigned_role: None,
            }
        }

        // A full-width title above two columns. The predecessor graph must emit
        // the title first, then the whole left column, then the whole right
        // column — the title interrupts any left→right chaining across columns.
        let segments = vec![
            seg("Title", 50.0, 470.0),
            seg("L1", 50.0, 440.0),
            seg("R1", 270.0, 440.0),
            seg("L2", 50.0, 300.0),
            seg("R2", 270.0, 300.0),
        ];

        fn hint(left: f32, bottom: f32, right: f32, top: f32) -> LayoutHint {
            LayoutHint {
                class_name: crate::pdf::structure::types::LayoutHintClass::Text,
                confidence: 0.95,
                left,
                bottom,
                right,
                top,
            }
        }

        let hints = vec![
            hint(40.0, 460.0, 460.0, 490.0),  // full-width title band
            hint(40.0, 100.0, 240.0, 450.0),  // left column
            hint(260.0, 100.0, 460.0, 450.0), // right column
        ];

        let reordered = reorder_segments_by_layout(segments, &hints);
        let order: Vec<&str> = reordered.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(
            order,
            vec!["Title", "L1", "L2", "R1", "R2"],
            "full-width heading must precede both columns, then each column reads top-to-bottom \
             without interleaving across the column boundary"
        );
    }

    #[test]
    fn test_reorder_spans_mixed_columns() {
        let spans = vec![
            TextSpan {
                text: "A".to_string(),
                x: 110.0,
                y: 480.0,
                width: 10.0,
                height: 12.0,
            },
            TextSpan {
                text: "B".to_string(),
                x: 110.0,
                y: 300.0,
                width: 10.0,
                height: 12.0,
            },
            TextSpan {
                text: "C".to_string(),
                x: 410.0,
                y: 470.0,
                width: 10.0,
                height: 12.0,
            },
            TextSpan {
                text: "D".to_string(),
                x: 410.0,
                y: 300.0,
                width: 10.0,
                height: 12.0,
            },
            TextSpan {
                text: "E".to_string(),
                x: 410.0,
                y: 150.0,
                width: 10.0,
                height: 12.0,
            },
            TextSpan {
                text: "X".to_string(),
                x: 550.0,
                y: 300.0,
                width: 10.0,
                height: 12.0,
            },
        ];

        let hints = vec![
            LayoutHint {
                class_name: crate::pdf::structure::types::LayoutHintClass::Text,
                confidence: 0.95,
                left: 100.0,
                bottom: 100.0,
                right: 200.0,
                top: 500.0,
            },
            LayoutHint {
                class_name: crate::pdf::structure::types::LayoutHintClass::Text,
                confidence: 0.95,
                left: 400.0,
                bottom: 100.0,
                right: 500.0,
                top: 500.0,
            },
        ];

        let order = reorder_spans_by_layout(&spans, &hints);
        assert_eq!(order.len(), 6);
        assert_eq!(order[0], 0);
        assert_eq!(order[1], 1);
        assert_eq!(order[2], 2);
        assert_eq!(order[3], 3);
        assert_eq!(order[4], 4);
        assert_eq!(order[5], 5);
    }

    #[test]
    fn test_reorder_spans_empty_input() {
        let spans = vec![];
        let hints = vec![];
        let order = reorder_spans_by_layout(&spans, &hints);
        assert!(order.is_empty());
    }

    #[test]
    fn test_reorder_spans_no_hints() {
        let spans = vec![
            TextSpan {
                text: "A".to_string(),
                x: 100.0,
                y: 100.0,
                width: 10.0,
                height: 12.0,
            },
            TextSpan {
                text: "B".to_string(),
                x: 120.0,
                y: 100.0,
                width: 10.0,
                height: 12.0,
            },
        ];
        let hints = vec![];
        let order = reorder_spans_by_layout(&spans, &hints);
        assert_eq!(order, vec![0, 1]);
    }

    #[test]
    fn test_config_default_reading_order_is_false() {
        let pdf_config = crate::core::config::PdfConfig::default();
        assert!(
            !pdf_config.reading_order,
            "Default reading_order must be false for backward compatibility"
        );
    }

    /// Test that within a region, a heading with a higher native index than its
    /// subsections is now emitted FIRST (top-to-bottom, not native order).
    /// This guards against issue #1170: chapter heading emitted after subsections.
    #[test]
    fn test_intra_region_segment_ordering_heading_before_subsections() {
        fn seg(text: &str, x: f32, y: f32) -> crate::pdf::hierarchy::SegmentData {
            crate::pdf::hierarchy::SegmentData {
                text: text.to_string(),
                x,
                y,
                width: 80.0,
                height: 12.0,
                font_size: 10.0,
                is_bold: false,
                is_italic: false,
                is_monospace: false,
                baseline_y: y,
                assigned_role: None,
            }
        }

        let segments = vec![
            seg("2.1 Algemeen", 50.0, 200.0),
            seg("2.1.1 ErP label", 50.0, 180.0),
            seg("2.1.2 Gascategorie", 50.0, 160.0),
            seg("Table row 1", 50.0, 140.0),
            seg("2 TOESTELGEGEVENS", 50.0, 450.0),
        ];

        let hints = vec![LayoutHint {
            class_name: crate::pdf::structure::types::LayoutHintClass::Text,
            confidence: 0.95,
            left: 40.0,
            bottom: 100.0,
            right: 400.0,
            top: 500.0,
        }];

        let reordered = reorder_segments_by_layout(segments, &hints);
        let order: Vec<&str> = reordered.iter().map(|s| s.text.as_str()).collect();

        assert_eq!(
            order,
            vec![
                "2 TOESTELGEGEVENS",
                "2.1 Algemeen",
                "2.1.1 ErP label",
                "2.1.2 Gascategorie",
                "Table row 1"
            ],
            "Within a region, segments must be ordered by top coordinate (y + height) descending, \
             so the heading (y=450) comes before its subsections (y=200, 180, 160, 140)"
        );
    }

    /// Test that sub-subsections are ordered correctly (2.1.1 before 2.1.2)
    /// when they have inverted native indices.
    #[test]
    fn test_intra_region_subsection_ordering() {
        fn seg(text: &str, x: f32, y: f32) -> crate::pdf::hierarchy::SegmentData {
            crate::pdf::hierarchy::SegmentData {
                text: text.to_string(),
                x,
                y,
                width: 80.0,
                height: 12.0,
                font_size: 10.0,
                is_bold: false,
                is_italic: false,
                is_monospace: false,
                baseline_y: y,
                assigned_role: None,
            }
        }

        let segments = vec![
            seg("2.1.2 Gascategorie", 50.0, 180.0),
            seg("2.1.1 ErP label", 50.0, 200.0),
        ];

        let hints = vec![LayoutHint {
            class_name: crate::pdf::structure::types::LayoutHintClass::Text,
            confidence: 0.95,
            left: 40.0,
            bottom: 100.0,
            right: 400.0,
            top: 500.0,
        }];

        let reordered = reorder_segments_by_layout(segments, &hints);
        let order: Vec<&str> = reordered.iter().map(|s| s.text.as_str()).collect();

        assert_eq!(
            order,
            vec!["2.1.1 ErP label", "2.1.2 Gascategorie"],
            "Segments within a region must be ordered by y coordinate, \
             so 2.1.1 (y=200) comes before 2.1.2 (y=180)"
        );
    }

    /// Test that span ordering works correctly within regions, matching segment behavior
    #[test]
    fn test_intra_region_span_ordering_heading_before_subsections() {
        let spans = vec![
            TextSpan {
                text: "2.1 Algemeen".to_string(),
                x: 50.0,
                y: 200.0,
                width: 80.0,
                height: 12.0,
            },
            TextSpan {
                text: "2.1.1 ErP".to_string(),
                x: 50.0,
                y: 180.0,
                width: 60.0,
                height: 12.0,
            },
            TextSpan {
                text: "2.1.2 Gas".to_string(),
                x: 50.0,
                y: 160.0,
                width: 60.0,
                height: 12.0,
            },
            TextSpan {
                text: "2 TOESTEL".to_string(),
                x: 50.0,
                y: 450.0,
                width: 80.0,
                height: 12.0,
            },
        ];

        let hints = vec![LayoutHint {
            class_name: crate::pdf::structure::types::LayoutHintClass::Text,
            confidence: 0.95,
            left: 40.0,
            bottom: 100.0,
            right: 400.0,
            top: 500.0,
        }];

        let order = reorder_spans_by_layout(&spans, &hints);
        assert_eq!(
            order,
            vec![3, 0, 1, 2],
            "Spans within a region must be ordered by top coordinate descending: \
             index 3 (y=450) first, then 0, 1, 2 (y=200, 180, 160)"
        );
    }

    /// Regression for issue #1198: NaN f32 coordinates in PDF spans create a cyclic
    /// comparison with `partial_cmp + unwrap_or(Equal)`, causing Rust's driftsort to
    /// panic with "comparison function does not correctly implement a total order".
    ///
    /// Concrete cycle produced by the old comparator (all 3 spans land in column 0
    /// because their x-centers are within COLUMN_MERGE_THRESHOLD_PTS):
    ///
    ///   A: top=NaN  x=1.0    B: top=17.0  x=0.0    C: top=22.0  x=2.0
    ///
    ///   compare(A, B): primary NaN→Equal, secondary x_A(1.0)>x_B(0.0) → Greater  (B before A)
    ///   compare(B, C): primary 17.0<22.0 → Greater                               (C before B)
    ///   compare(A, C): primary NaN→Equal, secondary x_A(1.0)<x_C(2.0) → Less    (A before C)
    ///
    /// → cycle  B < A,  C < B,  A < C  →  B < A < C < B  — driftsort panics.
    ///
    /// Fixed by using f32::total_cmp which places NaN after +inf, eliminating all
    /// non-finite ambiguity.  With total_cmp: NaN > 22.0 > 17.0, so A sorts first.
    #[test]
    fn test_geometric_sort_with_nan_top_does_not_panic() {
        let spans = vec![
            TextSpan {
                text: "A".to_string(),
                x: 1.0,
                y: f32::NAN,
                width: 10.0,
                height: 12.0,
            },
            TextSpan {
                text: "B".to_string(),
                x: 0.0,
                y: 5.0,
                width: 10.0,
                height: 12.0,
            },
            TextSpan {
                text: "C".to_string(),
                x: 2.0,
                y: 10.0,
                width: 10.0,
                height: 12.0,
            },
        ];
        let order = reorder_spans_geometric(&spans);
        assert_eq!(order.len(), 3, "all spans must be returned");
        assert_eq!(
            order[0], 0,
            "span with NaN top must sort first (NaN > finite in total_cmp)"
        );
        assert_eq!(order[1], 2, "C (top=22) must precede B (top=17)");
        assert_eq!(order[2], 1, "B (top=17) must be last");
    }

    /// Test geometric column detection when layout hints are absent
    #[test]
    fn test_geometric_column_fallback_two_columns() {
        let spans = vec![
            TextSpan {
                text: "Left top".to_string(),
                x: 50.0,
                y: 450.0,
                width: 80.0,
                height: 12.0,
            },
            TextSpan {
                text: "Left bottom".to_string(),
                x: 50.0,
                y: 200.0,
                width: 80.0,
                height: 12.0,
            },
            TextSpan {
                text: "Right top".to_string(),
                x: 300.0,
                y: 450.0,
                width: 80.0,
                height: 12.0,
            },
            TextSpan {
                text: "Right bottom".to_string(),
                x: 300.0,
                y: 200.0,
                width: 80.0,
                height: 12.0,
            },
        ];

        let order = reorder_spans_by_layout(&spans, &[]);
        assert_eq!(
            order,
            vec![0, 1, 2, 3],
            "Without hints, geometric fallback should detect columns by x-center \
             and order left column (0,1) before right column (2,3), top-to-bottom"
        );
    }
}
