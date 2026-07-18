/**
 * GcpOidcAuthenticator — verified MACHINE identity on GCP (ADR-0044, the GCP sibling
 * of ADR-0041's Cognito M2M). Where cognito-m2m verifies a Cognito client_credentials
 * access token, this verifies the **Google-signed OpenID Connect ID token** a service
 * account presents — the GA, Istio-verifiable identity the GCP profile's caller carries
 * (see docs/agent-engine-service-comparison.md, "SA OIDC vs SPIFFE"). A caller mints it
 * from the metadata server (`.../identity?audience=<aud>`) or `generateIdToken`; the
 * client SDK's `gcpIdentityTokenProvider` is the machine counterpart.
 *
 * Google ID tokens are signed by Google (JWKS at googleapis.com), issued by
 * `https://accounts.google.com`, and carry:
 *   - `sub`   — the SA's stable numeric id,
 *   - `email` — the SA email (deterministic, e.g. `svc@proj.iam.gserviceaccount.com`),
 *   - `aud`   — the audience the caller requested (we REQUIRE it match ours: an ID token
 *               minted for a different audience must not authenticate here),
 *   - `email_verified` — true for Google-issued SA/user tokens.
 * They CANNOT carry arbitrary custom claims (no Cognito-scope analog), so the tenant
 * can't ride in the token. Instead the two identity facts are:
 *   - subject = the verified `email` — the workload's identity;
 *   - tenant  = an external **SA→tenant grant** (`grants[email]`). Adding that binding
 *     IS the tenant-onboarding act — the GCP analog of granting the `agent-os/tenant.<t>`
 *     scope to a Cognito client. Fail closed when an authenticated SA has no grant
 *     (ADR-0009): a valid Google token without a tenant binding is still not admitted.
 * At scale the static map graduates to a ClaimSource-backed resolver (the seam oidc-sa
 * already uses) or a Firestore grant table; the port is unchanged either way.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Authenticator, AuthnContext, Principal } from "../gate";
import { UnauthorizedError } from "../gate";

/** Google's OIDC issuer + JWKS for ID tokens (SA and user). */
const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";

export interface GcpOidcOptions {
  /** The audience the ID token MUST carry — the front door's identifier, echoed by the
   *  caller when it mints the token. Required: without it, a token minted for any other
   *  Google service would authenticate here. */
  audience: string;
  /** SA email → tenant. The binding IS the onboarding act; unbound ⇒ not admitted. */
  grants: Record<string, string>;
  /** Optional allow-list of SA email domains (e.g. a project's
   *  `<proj>.iam.gserviceaccount.com`) — defense-in-depth beyond the grant map. */
  allowedEmailDomains?: string[];
  /** Override the issuer (tests / non-default). Default `https://accounts.google.com`. */
  issuer?: string;
  /** Key resolver override for tests; default = Google's remote JWKS, cached by jose. */
  keySource?: JWTVerifyGetKey;
}

export class GcpOidcAuthenticator implements Authenticator {
  readonly name = "gcp-oidc";
  private readonly audience: string;
  private readonly grants: Record<string, string>;
  private readonly allowedEmailDomains?: string[];
  private readonly issuer: string;
  private readonly keys: JWTVerifyGetKey;

  constructor(opts: GcpOidcOptions) {
    if (!opts.audience) throw new Error("gcp-oidc requires an audience");
    this.audience = opts.audience;
    this.grants = opts.grants ?? {};
    this.allowedEmailDomains = opts.allowedEmailDomains?.length ? opts.allowedEmailDomains : undefined;
    this.issuer = (opts.issuer ?? GOOGLE_ISSUER).replace(/\/$/, "");
    this.keys = opts.keySource ?? createRemoteJWKSet(new URL(GOOGLE_JWKS));
  }

  async authenticate(ctx: AuthnContext): Promise<Principal> {
    const token = ctx.credential;
    if (!token) throw new UnauthorizedError("missing bearer token");
    let claims: Record<string, unknown>;
    try {
      // signature (Google JWKS) + iss + aud (must be OURS) + exp/nbf, all in one check.
      ({ payload: claims } = await jwtVerify(token, this.keys, { issuer: this.issuer, audience: this.audience }));
    } catch {
      throw new UnauthorizedError("invalid token"); // don't leak which check failed
    }
    const email = claims.email;
    if (typeof email !== "string" || !email) throw new UnauthorizedError("ID token has no email (not a service-account/identity token?)");
    if (claims.email_verified !== true) throw new UnauthorizedError("ID token email is not verified");
    if (this.allowedEmailDomains && !this.allowedEmailDomains.some((d) => email.endsWith(`@${d}`) || email.endsWith(`.${d}`))) {
      throw new UnauthorizedError("caller email domain is not allowed");
    }
    const tenant = this.grants[email];
    if (!tenant) throw new UnauthorizedError(`no tenant grant for '${email}'`);
    return { tenant, subject: email, token };
  }
}
