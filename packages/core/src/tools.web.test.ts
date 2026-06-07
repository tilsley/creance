/**
 * Web research tools (slice 3, Model A): a fetch tool the trusted loop calls, whose
 * output the loop guards as untrusted ingress. The tool's own job is egress POLICY —
 * SSRF safety (no private/metadata hosts) + a per-tenant domain allowlist.
 */
import { test, expect, afterEach } from "bun:test";
import { isBlockedHost, assertFetchable, fetchUrlTool, webResearchTools } from "./tools";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("isBlockedHost — blocks localhost / private / loopback / link-local + metadata", () => {
  for (const h of ["localhost", "foo.local", "127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.169.254", "::1", "fe80::1"]) {
    expect(isBlockedHost(h)).toBe(true);
  }
  for (const h of ["example.com", "registry.npmjs.org", "8.8.8.8", "172.15.0.1", "172.32.0.1"]) {
    expect(isBlockedHost(h)).toBe(false);
  }
});

test("assertFetchable — scheme, SSRF, and allowlist enforcement", () => {
  expect(assertFetchable("https://example.com/x").hostname).toBe("example.com");
  expect(() => assertFetchable("ftp://example.com")).toThrow(/blocked scheme/);
  expect(() => assertFetchable("http://169.254.169.254/latest/meta-data")).toThrow(/blocked host/);
  expect(() => assertFetchable("http://localhost:8080")).toThrow(/blocked host/);
  // allowlist: only listed domains (and subdomains) pass
  expect(assertFetchable("https://docs.python.org/3/", ["python.org"]).hostname).toBe("docs.python.org");
  expect(() => assertFetchable("https://evil.com", ["python.org"])).toThrow(/not in research allowlist/);
});

test("fetch_url — returns body (capped) for an allowed public URL", async () => {
  globalThis.fetch = (async () => new Response("X".repeat(5000), { status: 200 })) as typeof fetch;
  const out = await fetchUrlTool({ maxBytes: 100 }).run({ url: "https://example.com" });
  expect(out.startsWith("HTTP 200 example.com")).toBe(true);
  expect(out.length).toBeLessThan(160); // header line + 100-byte body
});

test("fetch_url — refuses SSRF / non-allowlisted WITHOUT making a request", async () => {
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("secret"); }) as typeof fetch;
  expect(await fetchUrlTool().run({ url: "http://169.254.169.254/" })).toMatch(/blocked host/);
  expect(await fetchUrlTool({ allowDomains: ["python.org"] }).run({ url: "https://evil.com" })).toMatch(/not in research allowlist/);
  expect(called).toBe(false); // policy refuses before any network call
});

test("webResearchTools — fetch_url always; web_search only with a backend", async () => {
  expect(webResearchTools().map((t) => t.spec.name)).toEqual(["fetch_url"]);
  const withSearch = webResearchTools({ search: async (q) => `results for ${q}` });
  expect(withSearch.map((t) => t.spec.name)).toEqual(["fetch_url", "web_search"]);
  expect(await withSearch[1]!.run({ query: "pgvector" })).toBe("results for pgvector");
});
