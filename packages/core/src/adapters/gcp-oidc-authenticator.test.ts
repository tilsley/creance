/**
 * Proves the GCP machine-identity path (ADR-0044, the GCP sibling of 0041): a
 * Google-signed OIDC ID token is really verified (signature/iss/aud/exp against a
 * local JWKS), the subject is the verified SA email, and the tenant comes from the
 * external SA→tenant grant — fail closed when the SA has no binding, when the email
 * is unverified, when the audience is someone else's, or when the domain is off-list.
 */
import { test, expect } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { GcpOidcAuthenticator } from "./gcp-oidc-authenticator";
import { UnauthorizedError } from "../gate";

const ISSUER = "https://accounts.google.com";
const AUDIENCE = "https://inference.creance.example.com";
const SA = "svc-failure-analyst@decent-decker-270921.iam.gserviceaccount.com";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", use: "sig" }] });

function makeAuth(opts: Partial<ConstructorParameters<typeof GcpOidcAuthenticator>[0]> = {}) {
  return new GcpOidcAuthenticator({
    audience: AUDIENCE,
    grants: { [SA]: "teama" },
    keySource: jwks,
    ...opts,
  });
}

async function mint(
  claims: Record<string, unknown>,
  opts: { iss?: string; aud?: string; exp?: string; key?: CryptoKey } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(opts.key ?? privateKey);
}

const idClaims = { email: SA, email_verified: true, sub: "117201326905742721692" };

test("verifies an ID token: subject = SA email, tenant from the grant map", async () => {
  const token = await mint(idClaims);
  const p = await makeAuth().authenticate({ credential: token, headers: {} });
  expect(p).toMatchObject({ tenant: "teama", subject: SA });
  expect(p.token).toBe(token);
});

test("fails closed: SA has no tenant grant", async () => {
  const token = await mint({ ...idClaims, email: "stranger@decent-decker-270921.iam.gserviceaccount.com" });
  await expect(makeAuth().authenticate({ credential: token, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("fails closed: unverified email, missing email", async () => {
  const a = makeAuth();
  for (const bad of [
    await mint({ ...idClaims, email_verified: false }),
    await mint({ sub: "123" }),
  ]) {
    await expect(a.authenticate({ credential: bad, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
  }
});

test("rejects a token minted for a DIFFERENT audience (token reuse)", async () => {
  const token = await mint(idClaims, { aud: "https://some-other-google-service.example.com" });
  await expect(makeAuth().authenticate({ credential: token, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("rejects bad signature, wrong issuer, expired", async () => {
  const a = makeAuth();
  const { privateKey: wrongKey } = await generateKeyPair("RS256");
  for (const bad of [
    await mint(idClaims, { key: wrongKey }),
    await mint(idClaims, { iss: "https://evil.example.com" }),
    await mint(idClaims, { exp: "-5m" }),
  ]) {
    await expect(a.authenticate({ credential: bad, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
  }
});

test("allowedEmailDomains: off-list SA is rejected even with a valid signature", async () => {
  const a = makeAuth({
    grants: { [SA]: "teama", "attacker@evil.iam.gserviceaccount.com": "teama" },
    allowedEmailDomains: ["decent-decker-270921.iam.gserviceaccount.com"],
  });
  const good = await mint(idClaims);
  expect((await a.authenticate({ credential: good, headers: {} })).tenant).toBe("teama");
  const offList = await mint({ ...idClaims, email: "attacker@evil.iam.gserviceaccount.com" });
  await expect(a.authenticate({ credential: offList, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("missing credential is rejected", async () => {
  await expect(makeAuth().authenticate({ credential: undefined, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});
