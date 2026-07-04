/**
 * Proves the cognito-jwt authenticator (ADR-0032) actually VERIFIES — unlike
 * mesh-trust, which trusts an edge. Tokens here are really signed (jose) and
 * checked against a local JWKS, so the signature/iss/aud/exp paths are exercised
 * for real; only the network fetch of the key set is substituted.
 */
import { test, expect } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { CognitoJwtAuthenticator } from "./cognito-jwt-authenticator";
import { UnauthorizedError } from "../gate";

const ISSUER = "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_TESTPOOL";
const CLIENT_ID = "test-client-id";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", use: "sig" }] });

function makeAuth(opts: Partial<ConstructorParameters<typeof CognitoJwtAuthenticator>[0]> = {}) {
  return new CognitoJwtAuthenticator({ issuer: ISSUER, clientId: CLIENT_ID, keySource: jwks, ...opts });
}

async function mint(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string; key?: CryptoKey } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(opts.key ?? privateKey);
}

const idClaims = { token_use: "id", "custom:tenant": "teama", email: "alice@corp.com" };

test("verifies a signed id token and maps claims to the Principal", async () => {
  const token = await mint({ ...idClaims, "cognito:groups": ["eng", "admins"] });
  const p = await makeAuth().authenticate({ credential: token, headers: {} });
  expect(p).toMatchObject({ tenant: "teama", subject: "alice@corp.com", groups: ["eng", "admins"] });
  expect(p.token).toBe(token); // surfaced for downstream OBO exchange (ADR-0010)
});

test("falls back to sub when email is absent; custom tenant claim name works", async () => {
  const token = await mint({ token_use: "id", team: "teamb", sub: "user-123" });
  const p = await makeAuth({ tenantClaim: "team" }).authenticate({ credential: token, headers: {} });
  expect(p).toMatchObject({ tenant: "teamb", subject: "user-123" });
});

test("rejects a token signed by a different key (fail closed)", async () => {
  const { privateKey: wrongKey } = await generateKeyPair("RS256");
  const token = await mint(idClaims, { key: wrongKey });
  await expect(makeAuth().authenticate({ credential: token, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("rejects wrong audience, wrong issuer, and expired tokens", async () => {
  const a = makeAuth();
  for (const bad of [
    await mint(idClaims, { aud: "some-other-client" }),
    await mint(idClaims, { iss: "https://evil.example.com" }),
    await mint(idClaims, { exp: "-5m" }),
  ]) {
    await expect(a.authenticate({ credential: bad, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
  }
});

test("rejects an access token even if it would otherwise verify (token_use)", async () => {
  const token = await mint({ ...idClaims, token_use: "access" });
  await expect(makeAuth().authenticate({ credential: token, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("rejects a verified login with no tenant claim (tenant is the budget boundary)", async () => {
  const token = await mint({ token_use: "id", email: "alice@corp.com" });
  await expect(makeAuth().authenticate({ credential: token, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("rejects a missing credential", async () => {
  await expect(makeAuth().authenticate({ headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
});
