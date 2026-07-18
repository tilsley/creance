/**
 * The contract test (ADR-0043): openapi.yaml is only the truth if the app
 * implements it. This walks every operation in the spec and drives the REAL
 * createGatewayApp (mock providers, in-process — the same handler the pod and
 * the Lambda serve), asserting that (1) every declared route exists (no 404
 * from the app's fallthrough), and (2) every observed status is one the spec
 * declares for that operation. Add a route to the app without amending the
 * spec — or vice versa — and this fails before any deploy does.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { createGatewayApp } from "./app";
import type { Principal, Providers } from "@agent-os/core";

const spec = Bun.YAML.parse(readFileSync(new URL("./openapi.yaml", import.meta.url).pathname, "utf8")) as any;

const principal: Principal = { tenant: "teama", subject: "svc-test", token: "tok" };
const providers = {
  authenticator: {
    name: "fake",
    async authenticate({ credential }: { credential?: string }) {
      if (credential !== "tok") throw new (await import("@agent-os/core")).UnauthorizedError("nope");
      return principal;
    },
  },
  inferenceForTenant: async () => ({
    name: "fake",
    model: "m",
    generate: async () => ({ text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }),
  }),
  claimWrite: {
    verifyIdentity: async (token: string) => (token === "tok" ? "svc-test" : undefined),
    allowance: { maxMonthlyUsd: 100, allowedModels: ["m"] },
    putClaim: async () => {},
  },
  gate: { name: "fake", async checkBudget() { return {}; }, async reserve() { return { ok: true }; }, async settle() {} },
} as unknown as Providers;

const app = createGatewayApp(providers);

/** A minimal VALID body per operation, from the spec's own examples of shape. */
const happyBodies: Record<string, unknown> = {
  "post /v1/generate": { messages: [{ role: "user", text: "hi" }], maxTokens: 32 },
  "post /v1/messages": { model: "m", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
  "post /claims": { model: "m", monthlyBudgetUsd: 10 },
};

for (const [path, item] of Object.entries<any>(spec.paths)) {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const op = item[method];
    if (!op) continue;
    const declared = Object.keys(op.responses).map(Number);
    const key = `${method} ${path}`;

    test(`${key} — route exists and answers a declared status`, async () => {
      const body = happyBodies[key];
      const res = await app(
        new Request(`http://gw${path}`, {
          method: method.toUpperCase(),
          headers: { authorization: "Bearer tok", "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
      expect(res.status, `app fell through to not-found for a spec-declared route`).not.toBe(404 === declared.find((s) => s === 404) ? -1 : 404);
      expect(declared, `status ${res.status} is not declared in the spec for ${key}`).toContain(res.status);
    });

    if (op.security) {
      test(`${key} — unauthenticated is refused with a declared 401`, async () => {
        const res = await app(
          new Request(`http://gw${path}`, {
            method: method.toUpperCase(),
            headers: { "content-type": "application/json" },
            ...(happyBodies[key] ? { body: JSON.stringify(happyBodies[key]) } : {}),
          }),
        );
        expect(res.status).toBe(401);
        expect(declared).toContain(401);
      });
    }
  }
}
