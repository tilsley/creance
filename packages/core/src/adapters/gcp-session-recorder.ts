/**
 * GcpSessionRecorder — mirrors a completed Run into a GCP **Vertex AI Agent Engine
 * Session** so it surfaces in the Agent Engine console UI (ADR-0044 phase 5b). This is
 * the one place we introduce the managed "Sessions" concept: our conversation record is
 * the Run / RunStore (substrate-neutral), and this recorder is a GCP-only *observer* that
 * reflects a finished run's transcript into the managed Session store — it is NOT on the
 * run's critical path (a failure here never fails the run; the engine calls it best-effort).
 *
 * Dependency-free Vertex REST v1beta1 + ADC (same stance as the run/spend/memory adapters).
 * Contract discovered live 2026-07-19: `POST .../reasoningEngines/{id}/sessions {userId}`
 * (LRO, done:true) → Session; `POST .../sessions/{sid}:appendEvent {author, invocationId,
 * timestamp, content:{role, parts:[{text}]}}`; `GET .../sessions/{sid}/events`.
 *
 * One session per run: userId = the run's subject (so the console groups by caller),
 * invocationId = the run id (so events correlate back to the Run), one event per message.
 */
import type { Run } from "../runs";
import { gcpAccessToken } from "./gcp-auth";

/** GCP-only observer that reflects a finished Run into the managed Sessions store. */
export interface SessionRecorder {
  readonly name: string;
  /** Best-effort: mirror a run's transcript into a console-visible Session. Never throws
   *  in a way that should fail the run — callers invoke it with `.catch()`. */
  record(run: Run): Promise<void>;
}

export interface GcpSessionRecorderOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export class GcpSessionRecorder implements SessionRecorder {
  readonly name = "gcp-sessions";
  private readonly apiRoot: string;
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(project: string, location: string, engineId: string, opts: GcpSessionRecorderOptions = {}) {
    const host = opts.endpoint ?? `https://${location}-aiplatform.googleapis.com`;
    this.apiRoot = `${host}/v1beta1`;
    this.base = `${this.apiRoot}/projects/${project}/locations/${location}/reasoningEngines/${engineId}`;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await gcpAccessToken()}`, "content-type": "application/json" };
  }

  private async post(url: string, body: unknown): Promise<any> {
    const res = await this.fetch(url, { method: "POST", headers: await this.authHeaders(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`session recorder POST ${url} failed ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async record(run: Run): Promise<void> {
    const userId = run.principal?.subject ?? run.principal?.tenant ?? "anonymous";
    // CreateSession is an LRO that completes synchronously (done:true); the Session is in `.response`.
    const created = (await this.post(`${this.base}/sessions`, { userId })) as {
      name?: string;
      response?: { name?: string };
    };
    // The returned name is a bare resource path (with the project NUMBER); events are appended
    // to the full URL: {host}/v1beta1/{sessionName}:appendEvent.
    const sessionName = created.response?.name ?? created.name;
    if (!sessionName) throw new Error("session recorder: CreateSession returned no name");
    const sessionUrl = `${this.apiRoot}/${sessionName}`;
    // One event per message, in order. Author "user" for the human turn, else the runtime;
    // timestamps strictly increasing so the console preserves order. content.role uses the
    // Vertex convention ("user" | "model").
    const t0 = Date.parse(run.createdAt ?? "") || Date.now();
    for (let i = 0; i < run.messages.length; i++) {
      const m = run.messages[i]!;
      const isUser = m.role === "user";
      await this.post(`${sessionUrl}:appendEvent`, {
        author: isUser ? "user" : "agent-os",
        invocationId: run.id,
        timestamp: new Date(t0 + i).toISOString(),
        content: { role: isUser ? "user" : "model", parts: [{ text: (m as { text?: string }).text ?? "" }] },
      });
    }
  }
}
