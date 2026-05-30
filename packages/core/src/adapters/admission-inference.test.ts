/**
 * Proves the cost hard-stop (ADR-0013): the admission decorator refuses a request
 * whose worst-case cost would push the tenant over budget — BEFORE calling the
 * model — and otherwise admits the call and records actual spend.
 */
import { test, expect } from "bun:test";
import { AdmissionInferenceProvider } from "./admission-inference";
import { LocalGate } from "./local-gate";
import { BudgetExceededError } from "../gate";
import type { InferenceProvider, Message, ToolDef, GenerateOptions, AssistantTurn } from "../ports";

// a fake inner provider that counts calls and returns fixed usage
function fakeInner(usage = { inputTokens: 50, outputTokens: 50 }) {
  let calls = 0;
  const provider: InferenceProvider = {
    name: "fake",
    model: "amazon.nova-lite-v1:0", // in 0.06 / out 0.24 per Mtok
    async generate(_m: Message[], _t: ToolDef[], _o: GenerateOptions): Promise<AssistantTurn> {
      calls++;
      return { text: "ok", toolCalls: [], usage };
    },
  };
  return { provider, calls: () => calls };
}

const msgs: Message[] = [{ role: "user", text: "hello" }];
const tools: ToolDef[] = [];

test("admits a request within budget and records actual spend", async () => {
  const inner = fakeInner();
  const gate = new LocalGate("1.00"); // $1 / tenant
  const sut = new AdmissionInferenceProvider(inner.provider, gate, "teama");

  const turn = await sut.generate(msgs, tools, { maxTokens: 100 });

  expect(turn.text).toBe("ok");
  expect(inner.calls()).toBe(1); // the real call happened
  const status = await gate.checkBudget("teama");
  expect(status.spentUsd).toBeGreaterThan(0); // actual spend recorded
  expect(status.ok).toBe(true);
});

test("refuses the $50 one-shot BEFORE calling the model", async () => {
  const inner = fakeInner();
  const gate = new LocalGate("0.001"); // tiny cap
  const sut = new AdmissionInferenceProvider(inner.provider, gate, "teama");

  // worst case = 100_000 output tokens * $0.24/Mtok = $0.024  >> $0.001 cap
  const attempt = sut.generate(msgs, tools, { maxTokens: 100_000 });

  await expect(attempt).rejects.toBeInstanceOf(BudgetExceededError);
  expect(inner.calls()).toBe(0); // nothing was sent — the point of pre-flight admission
});

test("refuses once cumulative spend would tip over the cap", async () => {
  const inner = fakeInner();
  const gate = new LocalGate("0.02");
  const sut = new AdmissionInferenceProvider(inner.provider, gate, "teama");

  await gate.recordSpend("teama", 0.019); // already near the $0.02 cap
  // a request whose worst case (~$0.0024) tips cumulative over $0.02 is refused
  await expect(sut.generate(msgs, tools, { maxTokens: 10_000 })).rejects.toBeInstanceOf(BudgetExceededError);
  expect(inner.calls()).toBe(0);
});
