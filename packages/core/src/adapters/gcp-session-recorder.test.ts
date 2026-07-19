/**
 * Proves the Sessions mirror (ADR-0044 phase 5b) writes the right REST shapes without a
 * network: an injected fetch records the CreateSession + appendEvent calls. Asserts the
 * session is created with the run's subject as userId, one event per message with the
 * correct author/role/text and the run id as invocationId, in order.
 */
import { test, expect } from "bun:test";
import { GcpSessionRecorder } from "./gcp-session-recorder";
import type { Run } from "../runs";

process.env.GCP_ACCESS_TOKEN = "test-token"; // short-circuit gcp-auth (no metadata call)

const SESSION = "projects/p/locations/europe-west2/reasoningEngines/eng/sessions/999";

function fakeFetch(handler: (url: string, body: any) => any) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body });
    return { ok: true, status: 200, json: async () => handler(String(url), body) ?? {}, text: async () => "" } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const run: Run = {
  id: "run-42",
  status: "completed",
  task: "hi",
  principal: { tenant: "acme", subject: "svc@proj.iam.gserviceaccount.com" },
  messages: [
    { role: "user", text: "what is my db?" },
    { role: "assistant", text: "orinoco-prod" },
  ],
  createdAt: "2026-07-19T13:00:00.000Z",
  updatedAt: "2026-07-19T13:00:01.000Z",
} as unknown as Run;

test("record: creates a session (userId=subject) then appends one event per message", async () => {
  const { impl, calls } = fakeFetch((url) =>
    url.endsWith("/sessions") ? { response: { name: SESSION } } : {},
  );
  await new GcpSessionRecorder("p", "europe-west2", "eng", { fetchImpl: impl }).record(run);

  // 1 create + 2 appendEvent
  expect(calls.length).toBe(3);
  expect(calls[0]!.url).toEndWith("/sessions");
  expect(calls[0]!.body).toEqual({ userId: "svc@proj.iam.gserviceaccount.com" });

  expect(calls[1]!.url).toBe(`https://europe-west2-aiplatform.googleapis.com/v1beta1/${SESSION}:appendEvent`);
  expect(calls[1]!.body).toMatchObject({
    author: "user",
    invocationId: "run-42",
    content: { role: "user", parts: [{ text: "what is my db?" }] },
  });
  expect(calls[2]!.body).toMatchObject({
    author: "agent-os",
    invocationId: "run-42",
    content: { role: "model", parts: [{ text: "orinoco-prod" }] },
  });
  // strictly increasing timestamps preserve order
  expect(Date.parse(calls[2]!.body.timestamp)).toBeGreaterThan(Date.parse(calls[1]!.body.timestamp));
});

test("record: falls back to LRO name / tenant / anonymous, and tolerates empty transcript", async () => {
  const { impl, calls } = fakeFetch(() => ({ name: SESSION })); // create returns bare name (not under response)
  const noSubject = { ...run, principal: { tenant: "acme" }, messages: [] } as unknown as Run;
  await new GcpSessionRecorder("p", "europe-west2", "eng", { fetchImpl: impl }).record(noSubject);
  expect(calls.length).toBe(1); // create only, no events
  expect(calls[0]!.body).toEqual({ userId: "acme" }); // fell back to tenant
});
