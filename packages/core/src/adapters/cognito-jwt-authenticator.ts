/**
 * CognitoJwtAuthenticator — verified HUMAN identity from an OIDC user pool (ADR-0032).
 * The first authenticator whose subject is a person with a login, not a workload:
 * the console's Cognito hosted-UI sign-in yields a JWT, and that same token is the
 * Bearer credential this adapter verifies — one credential, no session-translation
 * layer between "logged into the website" and "authenticated at the gate".
 *
 * Unlike mesh-trust (which TRUSTS an edge that already verified), this adapter
 * verifies the token itself — signature against the pool's JWKS, plus issuer,
 * audience and expiry — because the serverless front door (ADR-0031) has no
 * verifying edge in front of it. Verification is offline after the first JWKS
 * fetch (jose caches the key set), so the hot path stays remote-call-free
 * (the ADR-0026 rule).
 *
 * It expects the **id token** (ADR-0032): Cognito access tokens carry neither the
 * `aud` claim nor custom attributes without a pre-token-generation hook, while the
 * id token has both. Tenant comes from a custom claim (`custom:tenant` by default) —
 * fail closed when absent: a verified login without a tenant grant is still not
 * admitted (tenant is the budget/isolation boundary, ADR-0009).
 *
 * Cognito-flavored defaults, but the mechanics are plain OIDC — point `issuer` at
 * any IdP that serves `{issuer}/.well-known/jwks.json` and it works the same.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Authenticator, AuthnContext, Principal } from "../gate";
import { UnauthorizedError } from "../gate";

export interface CognitoJwtOptions {
  /** The pool's OIDC issuer, e.g. `https://cognito-idp.eu-west-2.amazonaws.com/<poolId>`. */
  issuer: string;
  /** The app client id — must match the id token's `aud`. */
  clientId: string;
  /** Claim carrying the tenant (default `custom:tenant`). Fail closed when missing. */
  tenantClaim?: string;
  /** Claims tried in order for the subject (default email, then sub). */
  subjectClaims?: string[];
  /** Claim carrying group/role names (default `cognito:groups`) — input to authz. */
  groupsClaim?: string;
  /** Key resolver override for tests (a local JWKS); default = remote JWKS at
   *  `{issuer}/.well-known/jwks.json`, fetched once and cached by jose. */
  keySource?: JWTVerifyGetKey;
}

export class CognitoJwtAuthenticator implements Authenticator {
  readonly name = "cognito-jwt";
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly tenantClaim: string;
  private readonly subjectClaims: string[];
  private readonly groupsClaim: string;
  private readonly keys: JWTVerifyGetKey;

  constructor(opts: CognitoJwtOptions) {
    if (!opts.issuer || !opts.clientId) throw new Error("cognito-jwt requires issuer + clientId");
    this.issuer = opts.issuer.replace(/\/$/, "");
    this.clientId = opts.clientId;
    this.tenantClaim = opts.tenantClaim ?? "custom:tenant";
    this.subjectClaims = opts.subjectClaims ?? ["email", "sub"];
    this.groupsClaim = opts.groupsClaim ?? "cognito:groups";
    this.keys = opts.keySource ?? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async authenticate(ctx: AuthnContext): Promise<Principal> {
    const token = ctx.credential;
    if (!token) throw new UnauthorizedError("missing bearer token");
    let claims: Record<string, unknown>;
    try {
      // signature (JWKS) + iss + aud + exp/nbf, all in one verify
      ({ payload: claims } = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        audience: this.clientId,
      }));
    } catch {
      throw new UnauthorizedError("invalid token"); // don't leak which check failed
    }
    // Cognito stamps token_use; reject an access token explicitly (it verified only
    // because someone added the hook that gives access tokens aud — still wrong token).
    if (claims.token_use !== undefined && claims.token_use !== "id") {
      throw new UnauthorizedError("expected an id token");
    }
    const tenant = claims[this.tenantClaim];
    if (typeof tenant !== "string" || !tenant) {
      throw new UnauthorizedError(`verified login has no '${this.tenantClaim}' claim`);
    }
    const subject = this.subjectClaims.map((c) => claims[c]).find((v) => typeof v === "string" && v);
    if (typeof subject !== "string") throw new UnauthorizedError("token has no subject claim");
    const groupsRaw = claims[this.groupsClaim];
    const groups = Array.isArray(groupsRaw) ? groupsRaw.map(String) : undefined;
    return {
      tenant,
      subject,
      ...(groups ? { groups } : {}),
      token, // the subject_token for downstream OBO exchange (ADR-0010)
    };
  }
}
