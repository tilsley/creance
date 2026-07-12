/**
 * Proves the machine-identity path (ADR-0041): a client_credentials ACCESS token
 * is really verified (signature/iss/exp against a local JWKS), the subject is the
 * app client, and the tenant comes from exactly one resource-server scope grant —
 * fail closed on none or many. Also proves the composite: one pool, two credential
 * kinds, humans and machines through the same AUTHN=cognito door.
 */
import { test, expect } from "bun:test";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { CognitoM2mAuthenticator } from "./cognito-m2m-authenticator";
import { CognitoJwtAuthenticator } from "./cognito-jwt-authenticator";
import { CompositeAuthenticator } from "./composite-authenticator";
import { UnauthorizedError } from "../gate";
import type { Authenticator } from "../gate";

const ISSUER = "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_TESTPOOL";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", use: "sig" }] });

function makeAuth(opts: Partial<ConstructorParameters<typeof CognitoM2mAuthenticator>[0]> = {}) {
  return new CognitoM2mAuthenticator({ issuer: ISSUER, keySource: jwks, ...opts });
}

async function mint(claims: Record<string, unknown>, opts: { iss?: string; exp?: string; key?: CryptoKey } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.iss ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(opts.key ?? privateKey);
}

const m2mClaims = { token_use: "access", client_id: "svc-failure-analyst", scope: "agent-os/tenant.teama" };

test("verifies an access token: subject = client_id, tenant from the scope grant", async () => {
  const token = await mint(m2mClaims);
  const p = await makeAuth().authenticate({ credential: token, headers: {} });
  expect(p).toMatchObject({ tenant: "teama", subject: "svc-failure-analyst" });
  expect(p.token).toBe(token);
});

test("custom scope prefix works; other scopes are ignored", async () => {
  const token = await mint({ ...m2mClaims, scope: "other/read creance/tenant.teamb other/write" });
  const p = await makeAuth({ tenantScopePrefix: "creance/tenant." }).authenticate({ credential: token, headers: {} });
  expect(p.tenant).toBe("teamb");
});

test("fails closed: no tenant scope, multiple tenant scopes, missing client_id", async () => {
  const a = makeAuth();
  for (const bad of [
    await mint({ ...m2mClaims, scope: "openid email" }),
    await mint({ ...m2mClaims, scope: "agent-os/tenant.teama agent-os/tenant.teamb" }),
    await mint({ token_use: "access", scope: "agent-os/tenant.teama" }),
  ]) {
    await expect(a.authenticate({ credential: bad, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
  }
});

test("rejects an id token (wrong token_use), bad signature, wrong issuer, expired", async () => {
  const a = makeAuth();
  const { privateKey: wrongKey } = await generateKeyPair("RS256");
  for (const bad of [
    await mint({ ...m2mClaims, token_use: "id" }),
    await mint(m2mClaims, { key: wrongKey }),
    await mint(m2mClaims, { iss: "https://evil.example.com" }),
    await mint(m2mClaims, { exp: "-5m" }),
  ]) {
    await expect(a.authenticate({ credential: bad, headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
  }
});

// --- composite: the AUTHN=cognito door admits both credential kinds ---

const composite = new CompositeAuthenticator([
  new CognitoJwtAuthenticator({ issuer: ISSUER, clientId: "console-client", keySource: jwks }),
  new CognitoM2mAuthenticator({ issuer: ISSUER, keySource: jwks }),
]);

test("composite admits a human id token AND a machine access token", async () => {
  const idToken = await new SignJWT({ token_use: "id", "custom:tenant": "teama", email: "alice@corp.com" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(ISSUER)
    .setAudience("console-client")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  expect((await composite.authenticate({ credential: idToken, headers: {} })).subject).toBe("alice@corp.com");
  expect((await composite.authenticate({ credential: await mint(m2mClaims), headers: {} })).subject).toBe("svc-failure-analyst");
});

test("composite rejects when no candidate accepts; propagates non-Unauthorized errors", async () => {
  await expect(composite.authenticate({ credential: "garbage", headers: {} })).rejects.toBeInstanceOf(UnauthorizedError);
  const boom: Authenticator = {
    name: "boom",
    authenticate: async () => {
      throw new Error("jwks fetch failed");
    },
  };
  const c = new CompositeAuthenticator([boom, makeAuth()]);
  await expect(c.authenticate({ credential: await mint(m2mClaims), headers: {} })).rejects.toThrow("jwks fetch failed");
});
