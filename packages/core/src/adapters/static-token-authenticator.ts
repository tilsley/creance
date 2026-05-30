/**
 * StaticTokenAuthenticator — the dev/placeholder authn adapter (ADR-0015). Maps
 * opaque bearer tokens to principals from an env spec. Static shared secrets, no
 * expiry/rotation — for local dev only; real deployments use MeshTrustAuthenticator
 * (edge-verified claims) or an OIDC validator.
 *
 *   GATE_TOKENS="tok-a:teamA:alice,tok-b:teamB:bob"   (token:tenant:subject)
 */
import type { Authenticator, AuthnContext, Principal } from "../gate";
import { UnauthorizedError } from "../gate";

export class StaticTokenAuthenticator implements Authenticator {
  readonly name = "static-token";
  private readonly principals = new Map<string, Principal>();

  constructor(tokensSpec?: string) {
    for (const entry of (tokensSpec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const [token, tenant, subject] = entry.split(":");
      if (token && tenant) this.principals.set(token, { tenant, subject: subject ?? "unknown" });
    }
  }

  async authenticate(ctx: AuthnContext): Promise<Principal> {
    const principal = ctx.credential ? this.principals.get(ctx.credential) : undefined;
    if (!principal) throw new UnauthorizedError();
    return principal;
  }
}
