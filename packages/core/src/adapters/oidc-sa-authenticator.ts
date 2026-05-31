/**
 * OidcServiceAccountAuthenticator — the *verified* workload-identity adapter (ADR-0019,
 * hardening ADR-0015). Unlike MeshTrustAuthenticator (which decodes a header WITHOUT
 * checking the signature and trusts the `tenant` claim — forgeable unless a real edge
 * strips/validates it), this proves the caller's identity cryptographically and never
 * takes the tenant from the token:
 *
 *   1. VERIFY: the caller presents its Kubernetes projected ServiceAccount token as the
 *      bearer. We submit it to the cluster's TokenReview API — the API server validates
 *      signature + audience + expiry and returns the canonical identity
 *      (`system:serviceaccount:<ns>:<name>`). No JWKS plumbing; the cluster is the IdP.
 *   2. BIND: the tenant is resolved from a *cluster-side* binding — the
 *      TenantInferenceProfile whose `spec.serviceAccount` equals the verified SA — NOT
 *      from any token claim. So a caller gets only the tenant its proven identity is
 *      bound to, and cannot assert another (it can't forge the SA the API server returns).
 *
 * Deps are injected so the unit tests exercise the logic without a live cluster; the
 * kube-backed defaults (KubeTokenReviewer / KubeSaTenantResolver) are only constructed
 * when not supplied. JWKS/OIDC-discovery verification can be a second TokenReviewer
 * behind the same seam for non-Kubernetes callers (ADR-0019).
 *
 *   AUTHN=oidc-sa   OIDC_SA_AUDIENCE=agent-os   (the audience callers project their token for)
 */
import * as k8s from "@kubernetes/client-node";
import type { Authenticator, AuthnContext, Principal } from "../gate";
import { UnauthorizedError } from "../gate";

const GROUP = "platform.agent-os.io";
const VERSION = "v1alpha1";
const PLURAL = "tenantinferenceprofiles";
const SA_PREFIX = "system:serviceaccount:";

/** The verified result of a TokenReview — provider-agnostic so a JWKS reviewer can implement it too. */
export interface ReviewResult {
  authenticated: boolean;
  /** canonical identity, e.g. `system:serviceaccount:agent-os:agent-runtime`. */
  username?: string;
  groups?: string[];
  /** audiences the token is valid for (intersection the authenticator returned). */
  audiences?: string[];
  error?: string;
}

export interface TokenReviewer {
  review(token: string): Promise<ReviewResult>;
}

/** Maps a *verified* ServiceAccount identity → its tenant via the cluster claim (not the token). */
export interface SaTenantResolver {
  tenantFor(serviceAccount: string): Promise<string | undefined>;
}

/** The cluster-scoped CRD the SA→tenant binding lives in (group/version/plural). */
export interface ClaimCrd {
  group?: string;
  version?: string;
  plural?: string;
}

export interface OidcSaOptions {
  /** Expected token audience; also checked against the TokenReview's returned audiences. */
  audience?: string;
  reviewer?: TokenReviewer;
  resolver?: SaTenantResolver;
  /** Override the binding CRD coords (e.g. a standalone CRD, not the Crossplane claim). */
  claim?: ClaimCrd;
}

export class OidcServiceAccountAuthenticator implements Authenticator {
  readonly name = "oidc-sa";
  private readonly audience?: string;
  private readonly reviewer: TokenReviewer;
  private readonly resolver: SaTenantResolver;

  constructor(opts: OidcSaOptions = {}) {
    this.audience = opts.audience;
    this.reviewer = opts.reviewer ?? new KubeTokenReviewer(opts.audience);
    this.resolver = opts.resolver ?? new KubeSaTenantResolver(30_000, opts.claim);
  }

  async authenticate(ctx: AuthnContext): Promise<Principal> {
    const raw = ctx.credential ?? bearerFrom(ctx.headers);
    if (!raw) throw new UnauthorizedError("missing service-account bearer token");

    const review = await this.reviewer.review(raw);
    if (!review.authenticated) {
      throw new UnauthorizedError(`token rejected${review.error ? `: ${review.error}` : ""}`);
    }
    // defence-in-depth: if we requested an audience, require the API server to confirm it
    if (this.audience && !(review.audiences ?? []).includes(this.audience)) {
      throw new UnauthorizedError(`token not valid for audience '${this.audience}'`);
    }
    const subject = review.username;
    if (!subject || !subject.startsWith(SA_PREFIX)) {
      throw new UnauthorizedError("not a service-account identity");
    }

    // tenant comes from the verified SA → claim binding, NEVER from the token
    const tenant = await this.resolver.tenantFor(subject);
    if (!tenant) throw new UnauthorizedError(`no tenant bound to '${subject}'`);

    const groups = review.groups?.length ? review.groups : undefined;
    return {
      tenant,
      subject,
      ...(groups ? { groups } : {}),
      token: raw, // kept for downstream OBO exchange (ADR-0010/0016)
    };
  }
}

function bearerFrom(headers: Record<string, string | undefined>): string | undefined {
  const h = headers["authorization"];
  return h?.replace(/^Bearer\s+/i, "") || undefined;
}

/** TokenReview-backed reviewer: the cluster API server is the verifier (signature/audience/expiry). */
export class KubeTokenReviewer implements TokenReviewer {
  private readonly api: k8s.AuthenticationV1Api;
  constructor(private readonly audience?: string) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault(); // in-cluster SA token, or ~/.kube/config locally
    this.api = kc.makeApiClient(k8s.AuthenticationV1Api);
  }
  async review(token: string): Promise<ReviewResult> {
    const res = await this.api.createTokenReview({
      body: {
        apiVersion: "authentication.k8s.io/v1",
        kind: "TokenReview",
        spec: { token, ...(this.audience ? { audiences: [this.audience] } : {}) },
      },
    });
    const s = res.status ?? {};
    return {
      authenticated: s.authenticated === true,
      username: s.user?.username,
      groups: s.user?.groups,
      audiences: s.audiences,
      error: s.error,
    };
  }
}

/** Resolves tenant from the TenantInferenceProfile whose spec.serviceAccount matches. TTL-cached. */
export class KubeSaTenantResolver implements SaTenantResolver {
  private readonly api: k8s.CustomObjectsApi;
  private readonly group: string;
  private readonly version: string;
  private readonly plural: string;
  private cache?: { at: number; bySa: Map<string, string> };
  constructor(private readonly ttlMs = 30_000, claim: ClaimCrd = {}) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    this.api = kc.makeApiClient(k8s.CustomObjectsApi);
    this.group = claim.group ?? GROUP;
    this.version = claim.version ?? VERSION;
    this.plural = claim.plural ?? PLURAL;
  }
  async tenantFor(serviceAccount: string): Promise<string | undefined> {
    if (!this.cache || Date.now() - this.cache.at >= this.ttlMs) {
      const res: any = await this.api.listClusterCustomObject({ group: this.group, version: this.version, plural: this.plural });
      const bySa = new Map<string, string>();
      for (const o of res?.items ?? []) {
        const sa = o?.spec?.serviceAccount;
        const tenant = o?.spec?.tenant;
        if (typeof sa === "string" && typeof tenant === "string") bySa.set(sa, tenant);
      }
      this.cache = { at: Date.now(), bySa };
    }
    return this.cache.bySa.get(serviceAccount);
  }
}
