# Live RAG search in Claude Desktop

The default `xberg-mcp` server (`claude_desktop_config.json`) gives Claude
Desktop extraction, ingest, and PII-review tools with real consent/audit
checks — but its `rag_query` tool is a stub: it always errors, pointing you
here. Live semantic search over an already-ingested matter's chunks is served
by a **second**, separate MCP server: the native Rust `xberg` binary's own
`mcp` command, running its own `rag_query` tool.

This is opt-in and additional to the default setup, not a replacement for
it — you keep using `xberg-mcp` for everything else.

## Prerequisite

At least one matter must already be ingested through the web app (or the
Node host's `ingest_folder` tool) — `rag_query` searches the mirror bundle
that ingestion produces. There's nothing to query for a matter that's never
been ingested.

## 1. Install the Rust CLI

Either of:

```sh
brew install xberg-io/tap/xberg
# or
cargo install xberg
```

Confirm it works: `xberg --version`. (Docker (`ghcr.io/xberg-io/xberg`) also
ships the binary, but needs a different server entry below — step 3 covers
both.)

## 2. Get the embedding model files

`xberg mcp`'s `rag_query` embeds queries with a Granite embedding model.
Point it at a local directory containing:

- `model.safetensors`
- `tokenizer.json`
- `config.json`

Wherever you obtain these three files, put them together in one directory —
that directory is what `XBERG_GRANITE_MODEL_DIR` (below) must point to.

## 3. Add a second server entry

Open the same `claude_desktop_config.json` you already installed for
`xberg-mcp` (see the main [README](./README.md)) and add a second entry
alongside it:

```json
{
  "mcpServers": {
    "xberg": { "command": "xberg-mcp", "args": ["mcp"] },
    "xberg-rag": {
      "command": "xberg",
      "args": ["mcp"],
      "env": {
        "XBERG_RAG_ENABLED": "1",
        "XBERG_GRANITE_MODEL_DIR": "/absolute/path/to/granite-model"
      }
    }
  }
}
```

`rag_query` is only registered when `XBERG_RAG_ENABLED=1` is set — without
it, `xberg mcp` runs as an extraction-only server with no RAG tool at all.

### Docker instead of a local binary

If you installed via Docker rather than `brew`/`cargo`, there's no `xberg`
binary on your `PATH` for Claude Desktop to invoke directly — use `docker run`
as the command instead, with the model directory and data directory (see
[Mirrors directory](#mirrors-directory) below) each mounted in:

```json
{
  "mcpServers": {
    "xberg": { "command": "xberg-mcp", "args": ["mcp"] },
    "xberg-rag": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "/absolute/path/to/granite-model:/model:ro",
        "-v", "/absolute/path/to/.xberg:/data",
        "-e", "XBERG_RAG_ENABLED=1",
        "-e", "XBERG_GRANITE_MODEL_DIR=/model",
        "-e", "XBERG_DATA_DIR=/data",
        "ghcr.io/xberg-io/xberg:latest",
        "mcp"
      ]
    }
  }
}
```

`-i` (interactive, no `-t`/tty) is required — MCP speaks JSON-RPC over raw
stdio, and a tty would corrupt that stream. Mount your existing `~/.xberg`
directory (or wherever `XBERG_DATA_DIR` points) to `/data` so the container
sees the same mirrors the browser/`xberg-mcp` already wrote, not an empty one.

### Mirrors directory

Both servers default to reading matter mirrors from `~/.xberg/mirrors` (or
`$XBERG_DATA_DIR/mirrors` if you've set `XBERG_DATA_DIR`) — on one machine,
with no extra configuration, `xberg-rag` already sees the same mirrors
`xberg-mcp` and the browser wrote. Only set `XBERG_DATA_DIR` explicitly (on
both server entries, to the same value) if you're running them against a
non-default data directory or a shared/remote location.

## 4. Restart and verify

Restart Claude Desktop, then:

1. Ask it to list its available tools — confirm `rag_query` now appears
   under the `xberg-rag` server.
2. Run a real query against the matter you already ingested. Confirm the
   answer cites real chunks from that matter and contains no raw
   personally identifying information.

If a mirror was somehow built without redaction (for example, via `xberg rag
index` run directly against raw files instead of through the browser/`xberg-mcp`
ingest path), `rag_query` will refuse the call outright rather than return
that text — an error naming the affected chunk is itself a correctness
signal, not a bug to work around.

## Safety model

`rag_query` only ever serves chunk text that was already tokenized (e.g.
`{{C0_PERSON_1}}`) before it was ever embedded or written into the mirror —
that redaction happens once, in the browser's ingestion pipeline, before
anything reaches disk. On top of that, every `rag_query` response is
additionally scanned with a conservative, format-validated PII pattern
detector (email, phone, SSN, credit card, IBAN, and more) as defense in
depth; a hit that still looks like unredacted PII is refused rather than
returned. `xberg-rag` never sees or needs your matter passphrase — it only
ever reads chunk text, never the sealed vault.
