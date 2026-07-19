import { describe, it, expect } from "vitest";
import { injectToken, PLACEHOLDER_HTML } from "../src/static.js";

describe("injectToken", () => {
  it("inserts the token script right after <head>", () => {
    const out = injectToken("<html><head><title>x</title></head><body></body></html>", "abc123");
    expect(out).toContain('<head><script>window.__XBERG_TOKEN__="abc123";</script>');
    expect(out.indexOf("__XBERG_TOKEN__")).toBeLessThan(out.indexOf("<title>"));
  });

  it("JSON-escapes the token value", () => {
    const out = injectToken("<head></head>", 'a"b');
    expect(out).toContain('window.__XBERG_TOKEN__="a\\"b";');
  });

  it("prepends when there is no <head>", () => {
    const out = injectToken("<div>no head</div>", "tok");
    expect(out.startsWith('<script>window.__XBERG_TOKEN__="tok";</script>')).toBe(true);
  });

  it("works on the placeholder HTML (has a <head>)", () => {
    const out = injectToken(PLACEHOLDER_HTML, "tok");
    expect(out).toContain("__XBERG_TOKEN__");
  });

  it("escapes < so a </script> in the token cannot break out", () => {
    const out = injectToken("<head></head>", "</script><script>alert(1)</script>");
    expect(out).not.toContain("</script><script>alert(1)");
    expect(out).toContain("\\u003c/script>");
  });

  it("inserts right after <head ...> when the tag carries attributes", () => {
    const out = injectToken('<html><head lang="en"><title>x</title></head></html>', "tok");
    expect(out).toContain('<head lang="en"><script>window.__XBERG_TOKEN__="tok";</script>');
    expect(out.indexOf("__XBERG_TOKEN__")).toBeLessThan(out.indexOf("<title>"));
  });
});
