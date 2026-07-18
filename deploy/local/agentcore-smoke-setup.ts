/** Local smoke rig for the agentcore.ts entrypoint (ADR-0042 phase 1):
 *  create the agent-os-runs table on DynamoDB Local + seed one queued Run —
 *  playing the router's part; the entrypoint plays AgentCore Runtime's. */
// deploy/local is not a workspace member, so the SDK import goes through core's
// node_modules explicitly; the store import resolves its own deps from there.
import { DynamoDBClient, CreateTableCommand } from "../../packages/core/node_modules/@aws-sdk/client-dynamodb";
import { DynamoDBRunStore } from "../../packages/core/src/adapters/dynamodb-run-store";

const endpoint = "http://localhost:8000";
const client = new DynamoDBClient({ region: "eu-west-2", endpoint });

try {
  await client.send(
    new CreateTableCommand({
      TableName: "agent-os-runs",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "id", AttributeType: "S" },
        { AttributeName: "status", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "byStatus",
          KeySchema: [{ AttributeName: "status", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
  console.log("table created");
} catch (e: any) {
  if (e.name !== "ResourceInUseException") throw e;
  console.log("table exists");
}

const store = new DynamoDBRunStore("agent-os-runs", "eu-west-2", endpoint);
const now = new Date().toISOString();
const run = {
  id: crypto.randomUUID(),
  status: "queued" as const,
  task: "prove the agentcore entrypoint locally",
  principal: { tenant: "local" },
  messages: [],
  createdAt: now,
  updatedAt: now,
};
await store.create(run as any);
console.log(run.id);
