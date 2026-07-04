/**
 * DynamoAgentRegistry — the durable, cheap-profile `AgentRegistry` (ADR-0012). The
 * agent catalog lives in a DynamoDB table instead of AGENTS_JSON (redeploy-to-edit)
 * or a k8s CRD (needs a cluster). Register an agent with a PutItem and the very next
 * run can invoke it — no redeploy. On-demand billing → ~$0 idle, same as the runs +
 * budgets tables it sits beside.
 *
 * Table: PK `name` (string). The item is the AgentSpec verbatim. list() is a Scan —
 * fine for a personal-scale catalog (a handful of agents); revisit with a GSId if the
 * catalog ever grows large.
 *
 * The AgentRegistry PORT is read-only (get/list) — that's all the runtime needs.
 * putAgent()/deleteAgent() are extra write helpers on the concrete adapter for
 * registering agents (a CLI, a seeding script, or a future POST /agents), not part
 * of the port.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { AgentRegistry, AgentSpec } from "../agents";

export class DynamoAgentRegistry implements AgentRegistry {
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
      marshallOptions: { removeUndefinedValues: true }, // AgentSpec is mostly optional fields
    });
  }

  async get(name: string): Promise<AgentSpec | undefined> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { name } }));
    return r.Item as AgentSpec | undefined;
  }

  // POC: a Scan is fine for a small catalog. At scale, page or add a query store.
  async list(): Promise<AgentSpec[]> {
    const r = await this.doc.send(new ScanCommand({ TableName: this.table }));
    return ((r.Items ?? []) as AgentSpec[]).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Register (or overwrite) an agent. Not part of the AgentRegistry port. */
  async putAgent(spec: AgentSpec): Promise<void> {
    if (!spec.name) throw new Error("AgentSpec.name is required");
    await this.doc.send(new PutCommand({ TableName: this.table, Item: spec }));
  }

  /** Remove an agent. Not part of the AgentRegistry port. */
  async deleteAgent(name: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { name } }));
  }
}
