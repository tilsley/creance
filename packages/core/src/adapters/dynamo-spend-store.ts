/**
 * DynamoSpendStore — the durable, monthly-windowed `SpendStore` (the AWS resource
 * behind per-tenant cost enforcement, ADR-0013/0009). Spend survives a runtime
 * restart because it lives in DynamoDB, and the monthly budget resets for free:
 * each (tenant, period) is its own item, period = "YYYY-MM".
 *
 * The `add` is a DynamoDB atomic counter (`ADD spentUsd :d`), so concurrent turns
 * accumulate correctly without read-modify-write races on the *recording* side.
 * (Pre-flight admission can still race check-vs-record under heavy concurrency —
 * bounded by one request's worst case; a reserve/settle pass is the stricter fix.)
 *
 * Table: PK `tenant` (string), SK `period` (string), attr `spentUsd` (number).
 * On-demand billing → ~$0 idle. Provisioned by infra StateStack.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SpendStore } from "../gate";

export class DynamoSpendStore implements SpendStore {
  readonly name = "dynamodb";
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    region?: string,
    endpoint?: string, // for DynamoDB Local
  ) {
    const client = new DynamoDBClient({
      region: region ?? process.env.REGION ?? "eu-west-2",
      ...(endpoint ? { endpoint } : {}),
    });
    this.doc = DynamoDBDocumentClient.from(client);
  }

  async get(tenant: string, period: string): Promise<number> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { tenant, period } }));
    return (r.Item?.spentUsd as number | undefined) ?? 0;
  }

  async add(tenant: string, period: string, usd: number): Promise<number> {
    const r = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { tenant, period },
        UpdateExpression: "ADD spentUsd :d",
        ExpressionAttributeValues: { ":d": usd },
        ReturnValues: "UPDATED_NEW", // the new running total
      }),
    );
    return (r.Attributes?.spentUsd as number | undefined) ?? usd;
  }

  // Atomic conditional add: the ADD and the cap check are ONE UpdateItem, so concurrent
  // reservations can't both pass a read and then both add past the cap (ADR-0019).
  // `:ceil = ceiling - delta` is the max *pre*-value that keeps the post-value within
  // `ceiling`; attribute_not_exists covers the first write (0 <= :ceil since callers
  // ensure delta <= ceiling).
  async reserve(tenant: string, period: string, delta: number, ceiling: number): Promise<number | null> {
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { tenant, period },
          UpdateExpression: "ADD spentUsd :d",
          ConditionExpression: "attribute_not_exists(spentUsd) OR spentUsd <= :ceil",
          ExpressionAttributeValues: { ":d": delta, ":ceil": ceiling - delta },
          ReturnValues: "UPDATED_NEW",
        }),
      );
      return (r.Attributes?.spentUsd as number | undefined) ?? delta;
    } catch (e) {
      if ((e as { name?: string })?.name === "ConditionalCheckFailedException") return null; // would breach the cap
      throw e;
    }
  }
}
