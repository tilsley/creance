/**
 * CognitoM2mAuthenticator — verified MACHINE identity from the same user pool
 * (ADR-0041). Where cognito-jwt authenticates a person's id token, this verifies
 * the ACCESS token a confidential app client obtains via the OAuth2
 * client_credentials grant — the platform's answer to "how does a service
 * authenticate" (external agents per ADR-0040, later custom-kind tasks).
 *
 * Cognito access tokens carry no `aud` and no custom claims (pre-token-generation
 * hooks don't fire for client_credentials), so the two identity facts come from
 * what Cognito DOES stamp:
 *   - subject  = `client_id` — the app client is the workload's identity;
 *   - tenant   = a resource-server scope, `<prefix><tenant>` (default
 *     `agent-os/tenant.`). Granting that scope to a client IS the tenant
 *     onboarding act — the machine analog of setting `custom:tenant` on a user.
 * Fail closed on zero or multiple tenant scopes: an authenticated client without
 * exactly one tenant grant is still not admitted (ADR-0009).
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Authenticator, AuthnContext, Principal } from "../gate";
import { UnauthorizedError } from "../gate";

export interface CognitoM2mOptions {
  /** The pool's OIDC issuer — same pool as the human authenticator. */
  issuer: string;
  /** Scope prefix carrying the tenant (default `agent-os/tenant.`). */
  tenantScopePrefix?: string;
  /** Key resolver override for tests; default = remote JWKS, cached by jose. */
  keySource?: JWTVerifyGetKey;
}

export class CognitoM2mAuthenticator implements Authenticator {
  readonly name = "cognito-m2m";
  private readonly issuer: string;
  private readonly tenantScopePrefix: string;
  private readonly keys: JWTVerifyGetKey;

  constructor(opts: CognitoM2mOptions) {
    if (!opts.issuer) throw new Error("cognito-m2m requires issuer");
    this.issuer = opts.issuer.replace(/\/$/, "");
    this.tenantScopePrefix = opts.tenantScopePrefix ?? "agent-os/tenant.";
    this.keys = opts.keySource ?? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async authenticate(ctx: AuthnContext): Promise<Principal> {
    const token = ctx.credential;
    if (!token) throw new UnauthorizedError("missing bearer token");
    let claims: Record<string, unknown>;
    try {
      // signature (JWKS) + iss + exp/nbf; access tokens have no aud to check
      ({ payload: claims } = await jwtVerify(token, this.keys, { issuer: this.issuer }));
    } catch {
      throw new UnauthorizedError("invalid token"); // don't leak which check failed
    }
    if (claims.token_use !== "access") throw new UnauthorizedError("expected an access token");
    const subject = claims.client_id;
    if (typeof subject !== "string" || !subject) throw new UnauthorizedError("access token has no client_id");
    const scopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : [];
    const tenants = scopes.filter((s) => s.startsWith(this.tenantScopePrefix)).map((s) => s.slice(this.tenantScopePrefix.length));
    if (tenants.length !== 1 || !tenants[0]) {
      throw new UnauthorizedError(`client has ${tenants.length === 0 ? "no" : "multiple"} '${this.tenantScopePrefix}*' scope grants`);
    }
    return { tenant: tenants[0], subject, token };
  }
}
