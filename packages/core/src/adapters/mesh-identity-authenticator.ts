/**
 * MeshIdentityAuthenticator — full-mode workload authn (ADR-0026/0028): the service
 * mesh's inbound proxy mTLS-authenticates the calling POD and stamps its verified
 * identity in a header; the caller itself carries NO credential. Distinct from
 * MeshTrustAuthenticator (the edge-JWT flavor for human identity): here the identity
 * is a workload, the header value is an identity NAME (not claims), and — fixing the
 * ADR-0019 critique of header-trust — the tenant comes from the claim BINDING
 * (SaTenantResolver, default-deny), never from anything the caller could assert.
 *
 * Two mesh dialects, one canonical subject (`system:serviceaccount:<ns>:<sa>` — the
 * same form TokenReview returns, so the same claims serve both authn modes):
 *   - Linkerd: `l5d-client-id: <sa>.<ns>.serviceaccount.identity.linkerd.<trust-domain>`
 *   - Istio:   `x-forwarded-client-cert: ...;URI=spiffe://<trust-domain>/ns/<ns>/sa/<sa>`
 *     (XFCC; the LAST element is the peer OUR sidecar verified — earlier elements are
 *     upstream hops' claims, not ours to trust)
 * We run Linkerd locally because it's lighter; the org runs Istio — both are config
 * (`MESH_IDENTITY_HEADER`), not code paths the gateway cares about.
 *
 * SECURITY: only sound when the gateway is reachable exclusively through its meshed
 * inbound proxy, which sets the header itself and STRIPS client-supplied copies
 * (Linkerd and Istio both do). Never expose the gateway port around the mesh.
 */
import type { Authenticator, AuthnContext, Principal } from "../gate";
import { UnauthorizedError } from "../gate";
import type { SaTenantResolver } from "./oidc-sa-authenticator";

export interface MeshIdentityOptions {
  /** Header carrying the mesh-verified workload identity. Default: try Linkerd's
   *  `l5d-client-id`, then Istio's `x-forwarded-client-cert`. */
  header?: string;
  /** Verified SA → tenant binding (the same ClaimSource the oidc-sa path uses).
   *  Required — no binding, no tenant, no access (default-deny). */
  resolver?: SaTenantResolver;
}

const DEFAULT_HEADERS = ["l5d-client-id", "x-forwarded-client-cert"];

export class MeshIdentityAuthenticator implements Authenticator {
  readonly name = "mesh-id";
  private readonly headers: string[];
  private readonly resolver: SaTenantResolver;

  constructor(opts: MeshIdentityOptions = {}) {
    if (!opts.resolver) throw new Error("MeshIdentityAuthenticator requires a resolver (SA→tenant); see config's ClaimSource");
    this.headers = opts.header ? [opts.header.toLowerCase()] : DEFAULT_HEADERS;
    this.resolver = opts.resolver;
  }

  async authenticate(ctx: AuthnContext): Promise<Principal> {
    let subject: string | undefined;
    for (const h of this.headers) {
      const raw = ctx.headers[h];
      if (raw) subject = parseMeshIdentity(raw);
      if (subject) break;
    }
    if (!subject) {
      throw new UnauthorizedError(`no mesh-verified identity (${this.headers.join("/")}) — caller not meshed?`);
    }
    // tenant comes from the verified-identity → claim binding, NEVER from the caller
    const tenant = await this.resolver.tenantFor(subject);
    if (!tenant) throw new UnauthorizedError(`no tenant bound to '${subject}'`);
    return { tenant, subject }; // no token: the workload carries no credential (that's the point)
  }
}

/**
 * Parse a mesh identity header value → canonical `system:serviceaccount:<ns>:<sa>`,
 * or undefined if it doesn't parse (treated as unauthenticated, never as a fallback).
 */
export function parseMeshIdentity(value: string): string | undefined {
  // Istio XFCC: comma-separated elements, one per hop; trust only the LAST (our peer),
  // and only its URI= field — By= is the RECEIVER's own identity, not the caller's.
  if (value.includes("URI=") || value.includes("spiffe://")) {
    const lastElement = value.split(",").pop() ?? value;
    const m = /(?:^|;)URI="?spiffe:\/\/[^/]+\/ns\/([^/]+)\/sa\/([^;,"\s]+)/.exec(lastElement);
    return m ? `system:serviceaccount:${m[1]}:${m[2]}` : undefined;
  }
  // Linkerd: <sa>.<ns>.serviceaccount.identity.<linkerd-trust-domain...>
  const parts = value.split(".");
  if (parts.length >= 4 && parts[2] === "serviceaccount" && parts[3] === "identity" && parts[0] && parts[1]) {
    return `system:serviceaccount:${parts[1]}:${parts[0]}`;
  }
  return undefined;
}
