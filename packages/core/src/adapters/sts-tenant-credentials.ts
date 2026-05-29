/**
 * Per-tenant AWS workload identity (ADR-0014, realizes the "STS assume-role" swap-in
 * ADR-0010 anticipated). Given a tenant, returns AWS credentials for *that tenant's*
 * IAM role, so a run's model/tool calls act as the tenant — least privilege, not the
 * platform's ambient creds. Returns undefined to fall back to ambient (role not ready,
 * or feature off).
 *
 * KubeStsTenantCredentials reads the role ARN from the tenant's TenantInferenceProfile
 * claim (status.roleArn — surfaced by the composition) and hands back an STS
 * assume-role provider. Keyless: the provider assumes the role using the runtime's
 * base identity and auto-refreshes the short-lived creds. The ARN lookup is TTL-cached;
 * the assume-role provider does its own credential caching, so we reuse one provider
 * per tenant (rebuilding only if the ARN changes).
 */
import * as k8s from "@kubernetes/client-node";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@smithy/types";

const GROUP = "platform.agent-os.io";
const VERSION = "v1alpha1";
const PLURAL = "tenantinferenceprofiles";

export interface TenantCredentials {
  readonly name: string;
  /** AWS creds for the tenant's role, or undefined to use ambient creds. */
  forTenant(tenant: string): Promise<AwsCredentialIdentityProvider | undefined>;
}

export class KubeStsTenantCredentials implements TenantCredentials {
  readonly name = "kube-sts";
  private readonly api: k8s.CustomObjectsApi;
  private readonly cache = new Map<string, { arn: string; provider: AwsCredentialIdentityProvider }>();
  private readonly arnCache = new Map<string, { arn: string | undefined; at: number }>();

  constructor(
    private readonly region?: string,
    private readonly ttlMs = 60_000,
  ) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault(); // in-cluster SA token, or ~/.kube/config locally
    this.api = kc.makeApiClient(k8s.CustomObjectsApi);
  }

  async forTenant(tenant: string): Promise<AwsCredentialIdentityProvider | undefined> {
    const arn = await this.roleArnFor(tenant);
    if (!arn) return undefined; // role not provisioned yet → ambient fallback (retried next call)
    const cached = this.cache.get(tenant);
    if (cached && cached.arn === arn) return cached.provider;
    const provider = fromTemporaryCredentials({
      params: { RoleArn: arn, RoleSessionName: `agent-os-${tenant}`.slice(0, 64) },
      ...(this.region ? { clientConfig: { region: this.region } } : {}),
    });
    this.cache.set(tenant, { arn, provider });
    return provider;
  }

  private async roleArnFor(tenant: string): Promise<string | undefined> {
    const hit = this.arnCache.get(tenant);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.arn;
    const res: any = await this.api.listClusterCustomObject({ group: GROUP, version: VERSION, plural: PLURAL });
    const claim = (res?.items ?? []).find((o: any) => o?.spec?.tenant === tenant);
    const arn = claim?.status?.roleArn as string | undefined;
    this.arnCache.set(tenant, { arn, at: Date.now() });
    return arn;
  }
}
