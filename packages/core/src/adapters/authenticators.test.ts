/**
 * Proves the authn split (ADR-0015): static-token and mesh-trust adapters both
 * resolve to the same Principal shape, and identity comes from *verified claims*
 * (mesh) rather than a hand-typed string — the swappable authn seam.
 */
import { test, expect } from "bun:test";
import { StaticTokenAuthenticator } from "./static-token-authenticator";
import { MeshTrustAuthenticator } from "./mesh-trust-authenticator";
import { NoopAuthenticator } from "./noop-authenticator";
import { UnauthorizedError } from "../gate";

const noHeaders = { headers: {} };

test("StaticTokenAuthenticator maps a known bearer to its principal", async () => {
  const a = new StaticTokenAuthenticator("tok-a:teama:alice,tok-b:teamb:bob");
  expect(await a.authenticate({ credential: "tok-a", headers: {} })).toEqual({ tenant: "teama", subject: "alice" });
});

test("StaticTokenAuthenticator rejects unknown/missing tokens", async () => {
  const a = new StaticTokenAuthenticator("tok-a:teama:alice");
  await expect(a.authenticate({ credential: "nope", headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
  await expect(a.authenticate(noHeaders)).rejects.toBeInstanceOf(UnauthorizedError);
});

// build an unsigned JWT (header.payload.sig) — the edge already verified it
function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig-not-checked`;
}

test("MeshTrustAuthenticator reads tenant/subject/groups from edge-verified claims (JWT)", async () => {
  const a = new MeshTrustAuthenticator(); // defaults: header x-agentos-identity, tenant claim, email/sub subject
  const token = fakeJwt({ tenant: "teama", email: "alice@corp.com", groups: ["eng", "admins"] });
  const p = await a.authenticate({ headers: { "x-agentos-identity": token } });
  expect(p).toMatchObject({ tenant: "teama", subject: "alice@corp.com", groups: ["eng", "admins"] });
  expect(p.token).toBe(token); // raw token surfaced for downstream OBO exchange
});

test("MeshTrustAuthenticator also accepts a raw JSON claims blob + custom claim names", async () => {
  const a = new MeshTrustAuthenticator({ header: "x-id", tenantClaim: "custom:tenant" });
  const p = await a.authenticate({ headers: { "x-id": JSON.stringify({ "custom:tenant": "teamb", sub: "svc-1" }) } });
  expect(p).toMatchObject({ tenant: "teamb", subject: "svc-1" });
});

test("MeshTrustAuthenticator rejects a missing edge header (fail closed)", async () => {
  const a = new MeshTrustAuthenticator();
  await expect(a.authenticate(noHeaders)).rejects.toBeInstanceOf(UnauthorizedError);
});

test("NoopAuthenticator is open (default/anonymous)", async () => {
  expect(await new NoopAuthenticator().authenticate(noHeaders)).toEqual({ tenant: "default", subject: "anonymous" });
});
