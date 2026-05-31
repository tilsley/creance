/**
 * Proves the verified workload-identity adapter (ADR-0019): identity is the
 * TokenReview-verified ServiceAccount (not an unchecked claim), and tenant is bound
 * cluster-side by that verified SA — never read from the token. This is the fix for
 * MeshTrustAuthenticator's forgeable `tenant` claim.
 */
import { test, expect } from "bun:test";
import { OidcServiceAccountAuthenticator, type ReviewResult, type TokenReviewer, type SaTenantResolver } from "./oidc-sa-authenticator";
import { UnauthorizedError } from "../gate";

const reviewer = (r: ReviewResult): TokenReviewer => ({ async review() { return r; } });
const resolver = (bySa: Record<string, string>): SaTenantResolver => ({ async tenantFor(sa) { return bySa[sa]; } });

const OK: ReviewResult = { authenticated: true, username: "system:serviceaccount:agent-os:ticket-bot", audiences: ["agent-os"] };
const bound = resolver({ "system:serviceaccount:agent-os:ticket-bot": "teama" });

test("verified SA bound to a tenant → Principal (tenant from the binding, token surfaced)", async () => {
  const a = new OidcServiceAccountAuthenticator({ reviewer: reviewer(OK), resolver: bound });
  const p = await a.authenticate({ credential: "the-sa-token", headers: {} });
  expect(p).toMatchObject({ tenant: "teama", subject: "system:serviceaccount:agent-os:ticket-bot" });
  expect(p.token).toBe("the-sa-token"); // kept for downstream OBO
});

test("tenant is NEVER taken from the token — only the verified SA→claim binding decides", async () => {
  // a token whose body 'claims' tenant=evil; the binding maps the SA to teama
  const sneaky = `x.${Buffer.from(JSON.stringify({ tenant: "evil" })).toString("base64url")}.sig`;
  const a = new OidcServiceAccountAuthenticator({ reviewer: reviewer(OK), resolver: bound });
  const p = await a.authenticate({ credential: sneaky, headers: {} });
  expect(p.tenant).toBe("teama"); // not 'evil'
});

test("rejects an unauthenticated token (TokenReview said no) — fail closed", async () => {
  const a = new OidcServiceAccountAuthenticator({ reviewer: reviewer({ authenticated: false, error: "expired" }), resolver: bound });
  await expect(a.authenticate({ credential: "bad", headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("rejects a missing bearer", async () => {
  const a = new OidcServiceAccountAuthenticator({ reviewer: reviewer(OK), resolver: bound });
  await expect(a.authenticate({ headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("rejects a verified identity with no tenant binding", async () => {
  const a = new OidcServiceAccountAuthenticator({ reviewer: reviewer(OK), resolver: resolver({}) });
  await expect(a.authenticate({ credential: "tok", headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("rejects a non-service-account identity (e.g. a human user token)", async () => {
  const human: ReviewResult = { authenticated: true, username: "alice@corp", audiences: ["agent-os"] };
  const a = new OidcServiceAccountAuthenticator({ reviewer: reviewer(human), resolver: bound });
  await expect(a.authenticate({ credential: "tok", headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("enforces the expected audience when configured", async () => {
  const wrongAud: ReviewResult = { ...OK, audiences: ["someone-else"] };
  const a = new OidcServiceAccountAuthenticator({ audience: "agent-os", reviewer: reviewer(wrongAud), resolver: bound });
  await expect(a.authenticate({ credential: "tok", headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("accepts the bearer from the Authorization header too", async () => {
  const a = new OidcServiceAccountAuthenticator({ reviewer: reviewer(OK), resolver: bound });
  const p = await a.authenticate({ headers: { authorization: "Bearer header-tok" } });
  expect(p.tenant).toBe("teama");
  expect(p.token).toBe("header-tok");
});

test("passes through groups from the verified identity (input to authz)", async () => {
  const withGroups: ReviewResult = { ...OK, groups: ["system:serviceaccounts", "system:authenticated"] };
  const a = new OidcServiceAccountAuthenticator({ reviewer: reviewer(withGroups), resolver: bound });
  const p = await a.authenticate({ credential: "tok", headers: {} });
  expect(p.groups).toEqual(["system:serviceaccounts", "system:authenticated"]);
});
