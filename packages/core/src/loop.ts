/**
 * The L1 agent loop — depends ONLY on the ports (ADR-0003). It has no idea
 * whether `think` is Bedrock or Ollama, `do` is AgentCore or local, `guard` is
 * Bedrock Guardrails or a no-op, or where `record` sends its spans.
 *
 * Returns a structured RunResult (so a service can respond) while still logging
 * the trace to the console (handy for CLI + server logs).
 */
import type {
  InferenceProvider,
  SandboxProvider,
  ContentGuard,
  TelemetrySink,
  Message,
  ToolDef,
  ToolResult,
} from "./ports";

const runCodeTool: ToolDef = {
  name: "run_code",
  description:
    "Execute Python code in a secure sandbox and return its stdout. Use for any computation.",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string", description: "Python source to execute." } },
    required: ["code"],
  },
};

const indent = (s: string) => s.split("\n").map((l) => "    " + l).join("\n");

export interface RunOpts {
  inference: InferenceProvider;
  sandbox: SandboxProvider;
  guard: ContentGuard;
  telemetry: TelemetrySink;
  task: string;
  maxSteps?: number;
}

export interface RunResult {
  runId: string;
  status: "completed" | "blocked" | "max_steps";
  output?: string;
}

export async function runAgent({ inference, sandbox, guard, telemetry, task, maxSteps = 8 }: RunOpts): Promise<RunResult> {
  const runId = crypto.randomUUID();
  console.log(`▶ inference=${inference.name}  sandbox=${sandbox.name}  guard=${guard.name}  record=${telemetry.name}`);
  console.log(`▶ task: ${task}\n`);

  return telemetry.run({ "run.id": runId, "agent.task": task }, async (): Promise<RunResult> => {
    // guard: screen the input before it reaches the model
    const inputCheck = await telemetry.step("guard.screen", { "guard.direction": "input" }, async (span) => {
      const v = await guard.screen(task, "input");
      span.setAttrs({ "guard.intervened": v.intervened, "guard.blocked": v.blocked });
      return v;
    });
    if (inputCheck.blocked) {
      console.log("🛡 guard blocked the input — aborting");
      return { runId, status: "blocked" };
    }

    const session = await telemetry.step("sandbox.start", {}, () => sandbox.startSession());
    console.log(`✓ sandbox session: ${session.id}\n`);

    const messages: Message[] = [{ role: "user", text: inputCheck.text }];

    try {
      for (let step = 1; step <= maxSteps; step++) {
        const turn = await telemetry.step(
          "inference.generate",
          { "gen_ai.system": inference.name, "gen_ai.request.model": inference.model },
          async (span) => {
            const t = await inference.generate(messages, [runCodeTool]); // think
            span.setAttrs({
              "gen_ai.usage.input_tokens": t.usage?.inputTokens,
              "gen_ai.usage.output_tokens": t.usage?.outputTokens,
              "gen_ai.tool_calls": t.toolCalls.length,
            });
            return t;
          },
        );
        messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });
        if (turn.text) console.log(`🧠 ${turn.text}`);

        if (turn.toolCalls.length === 0) {
          console.log("\n✅ done");
          return { runId, status: "completed", output: turn.text };
        }

        const results: ToolResult[] = [];
        for (const call of turn.toolCalls) {
          if (call.name !== "run_code") continue;
          const code = String(call.input.code ?? "");
          console.log(`\n🛠  run_code:\n${indent(code)}`);

          let output = await telemetry.step("sandbox.run_code", { "code.bytes": code.length }, () =>
            session.runCode(code),
          ); // do

          // guard: screen untrusted tool output before it re-enters model context
          const verdict = await telemetry.step("guard.screen", { "guard.direction": "output" }, async (span) => {
            const v = await guard.screen(output, "input");
            span.setAttrs({ "guard.intervened": v.intervened });
            return v;
          });
          if (verdict.intervened) {
            console.log("🛡 guard intervened on tool output");
            output = verdict.text;
          }

          console.log(`📤 output:\n${indent(output)}\n`);
          results.push({ toolCallId: call.id, output });
        }
        messages.push({ role: "tool", results });
      }
      console.log("\n⚠ hit step limit");
      return { runId, status: "max_steps" };
    } finally {
      await telemetry.step("sandbox.stop", {}, () => session.close());
      console.log(`✓ session stopped: ${session.id}`);
    }
  });
}
