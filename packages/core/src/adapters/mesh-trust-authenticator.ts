/**
 * MeshTrustAuthenticator — trusts identity the *edge* already verified (ADR-0015).
 * In the user's org an Istio `RequestAuthentication` or Google IAP validates the
 * human's OIDC JWT and forwards it (or its claims) in a header; the app trusts that
 * and does NOT re-verify. Both edges reduce to the same contract — "verified claims
 * arrive in a header" — so this one adapter models both.
 *
 * It reads a configurable header (default `x-agentos-identity`). The value may be a
 * JWT (the edge-validated token, e.g. IAP's assertion) — we base64url-decode the
 * payload WITHOUT checking the signature (the edge did) — or a raw JSON claims blob.
 * Claim names are configurable to match the real IdP (e.g. tenant from `custom:tenant`,
 * subject from `email`). Locally we inject the header to simulate the edge — no mesh.
 *
 * SECURITY: only sound when the edge is the *sole* ingress and strips client-supplied
 * copies of the header (true behind Istio/IAP). Never expose this adapter directly.
 */
import type { Authenticator, AuthnContext, Principal } from "../gate";
import { UnauthorizedError } from "../gate";

export interface MeshTrustOptions {
  /** Header the edge forwards verified identity in. */
  header?: string;
  /** Claim → Principal mapping (first present wins for each). */
  tenantClaim?: string;
  subjectClaims?: string[];
  groupsClaim?: string;
}

export class MeshTrustAuthenticator implements Authenticator {
  readonly name = "mesh-trust";
  private readonly header: string;
  private readonly tenantClaim: string;
  private readonly subjectClaims: string[];
  private readonly groupsClaim: string;

  constructor(opts: MeshTrustOptions = {}) {
    this.header = (opts.header ?? "x-agentos-identity").toLowerCase();
    this.tenantClaim = opts.tenantClaim ?? "tenant";
    this.subjectClaims = opts.subjectClaims ?? ["email", "sub"];
    this.groupsClaim = opts.groupsClaim ?? "groups";
  }

  async authenticate(ctx: AuthnContext): Promise<Principal> {
    const raw = ctx.headers[this.header];
    if (!raw) throw new UnauthorizedError(`missing edge identity header '${this.header}'`);
    const claims = decodeClaims(raw);
    const tenant = claims?.[this.tenantClaim];
    const subject = this.subjectClaims.map((c) => claims?.[c]).find(Boolean);
    if (!claims || typeof tenant !== "string" || typeof subject !== "string") {
      throw new UnauthorizedError(`edge identity missing '${this.tenantClaim}'/subject claims`);
    }
    const groupsRaw = claims[this.groupsClaim];
    const groups = Array.isArray(groupsRaw) ? groupsRaw.map(String) : undefined;
    // walk the nested `act` claim → the agent delegation chain (A2A; ADR-0017)
    const actors = actorChain(claims);
    return {
      tenant,
      subject,
      ...(groups ? { groups } : {}),
      ...(actors.length ? { actors } : {}),
      token: raw, // the subject_token for downstream OBO exchange (ADR-0010)
    };
  }
}

/** A JWT (header.payload.sig) → decode payload (no verify); else parse as JSON. */
function decodeClaims(value: string): Record<string, any> | undefined {
  try {
    const parts = value.split(".");
    const body = parts.length === 3 ? parts[1]! : value;
    const json = parts.length === 3 ? base64UrlDecode(body) : body;
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** RFC 8693 nests `act` to express a delegation chain; flatten it, most-recent first. */
function actorChain(claims: Record<string, any>): string[] {
  const out: string[] = [];
  for (let a = claims.act; a && typeof a === "object"; a = a.act) {
    if (a.sub) out.push(String(a.sub));
  }
  return out;
}

function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Buffer.from(b64, "base64").toString("utf8");
}
