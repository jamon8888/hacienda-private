cask("xberg-mcp") do
  version("1.0.0-rc.27")
  # macOS universal/arm64 asset published by the release workflow.
  url("https://github.com/xberg-io/xberg/releases/latest/download/xberg-mcp-darwin")
  # :no_check because the binary is rebuilt per tag; CI publishes SHA256SUMS.
  # TODO: pin with the released SHA256 once available, e.g. sha256 "abc123..."
  sha256(:no_check)
  name("Xberg MCP")
  desc("Local lawyer document-intelligence server + MCP endpoint (zero toolchain)")
  homepage("https://github.com/xberg-io/xberg")

  binary("xberg-mcp")

  zap(
    trash: [
      "~/.xberg"
    ]
  )
end
