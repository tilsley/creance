/**
 * FirestoreRunStore — the durable `RunStore` for the GCP managed profile (ADR-0042's
 * sibling), the Firestore analog of DynamoDBRunStore. It exists for one reason: the
 * DISPATCH=agentengine path SPLITS a run's lifecycle across two processes — the front
 * door creates it (status=queued) and hands off, then the managed Agent Runtime
 * container executes it. Both sides must see the SAME run, so an in-process store won't
 * do; they share a Firestore collection. (Phase-2 sidestepped this by carrying the whole
 * task inline in the :query, so the engine created+ran it in one process — the front-door
 * path can't.)
 *
 * Dependency-free by design (same stance as the Vertex adapter): plain Firestore REST v1
 * with an ADC bearer token — NO google-cloud SDK in the shared runtime image. Firestore
 * is serverless + scale-to-zero + on-demand billed → ~$0 idle, matching the DynamoDB
 * store's cost shape and the profile's cost-sensitive brief.
 *
 * Storage shape: the whole Run is stashed as a JSON string in a `json` field; `status`
 * and `createdAt` are duplicated into their own indexed string fields so listByStatus /
 * list can query/order server-side (single-field indexes are auto-created). This avoids a
 * full Firestore typed-value encoder for the nested messages[] / usage — honest for a POC.
 *
 * Concurrency: update() is read-modify-write (non-atomic). Safe here because a run has a
 * single writer at a time — the front door only ever creates (queued), and thereafter only
 * the executing engine mutates it. At scale, move to a Firestore transaction / field-mask
 * patch (mirrors the DynamoDB store's atomic UpdateExpression).
 */
import type { Run, RunStatus, RunStore } from "../runs";
import { gcpAccessToken } from "./gcp-auth";

interface FsDocument {
  name?: string;
  fields?: { json?: { stringValue?: string } };
}

export class FirestoreRunStore implements RunStore {
  readonly name = "firestore";
  private readonly base: string;
  private readonly collection: string;

  constructor(
    project: string,
    opts: { database?: string; collection?: string; endpoint?: string } = {},
  ) {
    const database = opts.database ?? "(default)";
    const host = opts.endpoint ?? "https://firestore.googleapis.com";
    this.base = `${host}/v1/projects/${project}/databases/${database}/documents`;
    this.collection = opts.collection ?? "runs";
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await gcpAccessToken()}`, "content-type": "application/json" };
  }

  /** A Run → Firestore document. status/createdAt are lifted out for server-side query. */
  private encode(run: Run): { fields: Record<string, { stringValue: string }> } {
    return {
      fields: {
        json: { stringValue: JSON.stringify(run) },
        status: { stringValue: run.status },
        createdAt: { stringValue: run.createdAt },
      },
    };
  }

  private decode(doc: FsDocument): Run {
    const raw = doc.fields?.json?.stringValue;
    if (!raw) throw new Error(`Firestore run doc missing json field: ${doc.name ?? "(unnamed)"}`);
    return JSON.parse(raw) as Run;
  }

  async create(run: Run): Promise<void> {
    const res = await fetch(`${this.base}/${this.collection}?documentId=${encodeURIComponent(run.id)}`, {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify(this.encode(run)),
    });
    if (!res.ok) throw new Error(`Firestore create ${run.id} failed ${res.status}: ${await res.text()}`);
  }

  async get(id: string): Promise<Run | undefined> {
    const res = await fetch(`${this.base}/${this.collection}/${encodeURIComponent(id)}`, {
      headers: await this.authHeaders(),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Firestore get ${id} failed ${res.status}: ${await res.text()}`);
    return this.decode((await res.json()) as FsDocument);
  }

  async update(id: string, patch: Partial<Run>): Promise<Run> {
    const current = await this.get(id);
    if (!current) throw new Error(`run not found: ${id}`);
    const next: Run = { ...current, ...patch, updatedAt: new Date().toISOString() };
    // Full-document PATCH (no updateMask ⇒ the provided fields replace the doc). Upserts,
    // but we've already asserted existence above to match the store's not-found contract.
    const res = await fetch(`${this.base}/${this.collection}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: await this.authHeaders(),
      body: JSON.stringify(this.encode(next)),
    });
    if (!res.ok) throw new Error(`Firestore update ${id} failed ${res.status}: ${await res.text()}`);
    return next;
  }

  private async runQuery(structuredQuery: Record<string, unknown>): Promise<Run[]> {
    const res = await fetch(`${this.base}:runQuery`, {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) throw new Error(`Firestore runQuery failed ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as Array<{ document?: FsDocument }>;
    return rows.filter((r) => r.document).map((r) => this.decode(r.document!));
  }

  async listByStatus(status: RunStatus): Promise<Run[]> {
    return this.runQuery({
      from: [{ collectionId: this.collection }],
      where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: status } } },
    });
  }

  async list(limit = 100): Promise<Run[]> {
    return this.runQuery({
      from: [{ collectionId: this.collection }],
      orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
      limit,
    });
  }
}
