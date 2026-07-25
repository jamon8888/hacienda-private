#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/tmp/pr31"
GH_BIN="${GH_BIN:-gh}"
REPO="jamon8888/hacienda-private"
PR="31"

mkdir -p "$OUT_DIR"

"$GH_BIN" pr view "$PR" --repo "$REPO" \
  --json number,title,headRefName,baseRefName,author,body,mergeStateStatus,reviewDecision,commits,files,reviews \
  > "$OUT_DIR/pr_view.json"

# Reviews: paginate fully and flatten to a single JSON array
"$GH_BIN" api "repos/$REPO/pulls/$PR/reviews" --paginate \
  | jq -s 'flatten' > "$OUT_DIR/reviews.json"

# Comments: paginate fully and flatten to a single JSON array
"$GH_BIN" api "repos/$REPO/pulls/$PR/comments" --paginate \
  | jq -s 'flatten' > "$OUT_DIR/comments.json"

if command -v jq >/dev/null 2>&1; then
  jq '.[] | {id, user: .user.login, state, submitted_at, body}' "$OUT_DIR/reviews.json" \
    > "$OUT_DIR/reviews.summary.json"
  jq '.[] | {id, user: .user.login, path, line, original_line, side, in_reply_to_id, body}' "$OUT_DIR/comments.json" \
    > "$OUT_DIR/comments.summary.json"
fi

echo "Wrote PR data to $OUT_DIR"
