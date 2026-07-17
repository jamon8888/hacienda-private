// Local-first egress guard (T1). Document content must never leave the device. The only permitted
// network sinks are the SHA256-pinned model fetcher (served by the Node service) and localhost HTTP
// to that same service. This pure function is a startup invariant check used by the engine.

const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1"];

export function assertLocalFirst(url: string, allowedHosts: string[] = DEFAULT_ALLOWED_HOSTS): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL rejected by egress guard: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`non-http(s) URL rejected by egress guard: ${url}`);
  }
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || allowedHosts.includes(host)) {
    return;
  }
  throw new Error(`remote egress rejected by local-first guard: ${url}`);
}
