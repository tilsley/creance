/**
 * DynamoClaimSource (ADR-0021) — the non-Kubernetes ClaimSource: inference grants live in a
 * DynamoDB table (next to the slice-3 spend counter), so a deployed service with an IAM role —
 * not a k8s pod — can be granted inference without `kubectl`. Symmetric with KubeClaimSource: it
 * satisfies ClaimSource + BudgetSource (cap) + SaTenantResolver (identity→tenant) from the same
 * store, so the gateway reads it through the unchanged seams (CLAIM_SOURCE=dynamo).
 *
 * Table `agent-os-claims`: PK `serviceAccount` (the verified identity) → { tenant, model,
 * monthlyBudgetUsd, sessionBudgetUsd }; GSI `tenant-index` (PK `tenant`) for the budget lookup.
 *
 * The reader is injected (default = DynamoDB) so unit tests need no DynamoDB Local; a real run
 * needs the table (+ endpoint for DynamoDB Local).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { ClaimSource, InferenceClaim } from "../claims";
import type { BudgetSource } from "../gate";
import type { SaTenantResolver } from "./oidc-sa-authenticator";

/** Raw-item reads, injectable for tests. */
export interface DynamoClaimReader {
  byServiceAccount(serviceAccount: string): Promise<any | undefined>;
  byTenant(tenant: string): Promise<any | undefined>;
}

export interface DynamoClaimOptions {
  region?: string;
  endpoint?: string; // DynamoDB Local
  tenantIndex?: string; // GSI name (default "tenant-index")
  reader?: DynamoClaimReader;
}

export class DynamoClaimSource implements ClaimSource, BudgetSource, SaTenantResolver {
  readonly name = "dynamo-claim";
  private readonly reader: DynamoClaimReader;

  constructor(private readonly table: string, opts: DynamoClaimOptions = {}) {
    if (opts.reader) {
      this.reader = opts.reader;
    } else {
      const doc = DynamoDBDocumentClient.from(
        new DynamoDBClient({ region: opts.region ?? process.env.REGION ?? "eu-west-2", ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) }),
      );
      const index = opts.tenantIndex ?? "tenant-index";
      this.reader = {
        byServiceAccount: async (sa) => (await doc.send(new GetCommand({ TableName: table, Key: { serviceAccount: sa } }))).Item,
        byTenant: async (tenant) => {
          const r = await doc.send(
            new QueryCommand({ TableName: table, IndexName: index, KeyConditionExpression: "tenant = :t", ExpressionAttributeValues: { ":t": tenant }, Limit: 1 }),
          );
          return r.Items?.[0];
        },
      };
    }
  }

  async forServiceAccount(serviceAccount: string): Promise<InferenceClaim | undefined> {
    return toClaim(await this.reader.byServiceAccount(serviceAccount));
  }
  async forTenant(tenant: string): Promise<InferenceClaim | undefined> {
    return toClaim(await this.reader.byTenant(tenant));
  }
  async limitFor(tenant: string): Promise<number | undefined> {
    return (await this.forTenant(tenant))?.monthlyBudgetUsd;
  }
  async tenantFor(serviceAccount: string): Promise<string | undefined> {
    return (await this.forServiceAccount(serviceAccount))?.tenant;
  }
}

function toClaim(item: any): InferenceClaim | undefined {
  if (!item || typeof item.tenant !== "string") return undefined;
  const num = (v: unknown) => {
    const n = Number(v);
    return v != null && Number.isFinite(n) ? n : undefined;
  };
  return {
    tenant: item.tenant,
    serviceAccount: typeof item.serviceAccount === "string" ? item.serviceAccount : undefined,
    model: typeof item.model === "string" ? item.model : undefined,
    monthlyBudgetUsd: num(item.monthlyBudgetUsd),
    sessionBudgetUsd: num(item.sessionBudgetUsd),
  };
}
