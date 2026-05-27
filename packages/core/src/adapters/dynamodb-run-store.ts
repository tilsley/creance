/**
 * DynamoDBRunStore — the durable `RunStore` adapter (the AWS resource behind the
 * State primitive). A run survives a runtime restart because it lives in DynamoDB,
 * not process memory. On-demand billing → ~$0 idle.
 *
 * Table: PK `id` (string). GSI `byStatus` (PK `status`) for reconciliation
 * (find interrupted runs on boot). `status` is a DynamoDB reserved word — aliased
 * via ExpressionAttributeNames everywhere.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Run, RunStatus, RunStore } from "../runs";

export class DynamoDBRunStore implements RunStore {
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
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true }, // optional Run fields
    });
  }

  async create(run: Run): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: run }));
  }

  async get(id: string): Promise<Run | undefined> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { id } }));
    return r.Item as Run | undefined;
  }

  async update(id: string, patch: Partial<Run>): Promise<Run> {
    const next: Record<string, unknown> = { ...patch, updatedAt: new Date().toISOString() };
    // skip undefined (e.g. a blocked run has no `output`) — else the SET expression
    // references a value the marshaller drops -> "expression attribute value not defined".
    const keys = Object.keys(next).filter((k) => next[k] !== undefined);
    const r = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { id },
        UpdateExpression: "SET " + keys.map((_, i) => `#k${i} = :v${i}`).join(", "),
        ExpressionAttributeNames: Object.fromEntries(keys.map((k, i) => [`#k${i}`, k])),
        ExpressionAttributeValues: Object.fromEntries(keys.map((k, i) => [`:v${i}`, next[k]])),
        ConditionExpression: "attribute_exists(id)",
        ReturnValues: "ALL_NEW",
      }),
    );
    return r.Attributes as Run;
  }

  async listByStatus(status: RunStatus): Promise<Run[]> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "byStatus",
        KeyConditionExpression: "#s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": status },
      }),
    );
    return (r.Items ?? []) as Run[];
  }
}
