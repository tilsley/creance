/**
 * The L1 agent loop — depends ONLY on the ports (ADR-0003). It has no idea
 * whether `think` is Bedrock or Ollama, `do` is AgentCore or local, or `guard`
 * is Bedrock Guardrails or a no-op.
 */
import type {
  InferenceProvider,
  SandboxProvider,
  ContentGuard,
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
  task: string;
  maxSteps?: number;
}

export async function runAgent({ inference, sandbox, guard, task, maxSteps = 8 }: RunOpts): Promise<void> {
  console.log(`▶ inference=${inference.name}  sandbox=${sandbox.name}  guard=${guard.name}`);
  console.log(`▶ task: ${task}\n`);

  // guard: screen the input before it ever reaches the model
  const inputCheck = await guard.screen(task, "input");
  if (inputCheck.blocked) {
    console.log("🛡 guard blocked the input — aborting");
    return;
  }

  const session = await sandbox.startSession();
  console.log(`✓ sandbox session: ${session.id}\n`);

  const messages: Message[] = [{ role: "user", text: inputCheck.text }];

  try {
    for (let step = 1; step <= maxSteps; step++) {
      const turn = await inference.generate(messages, [runCodeTool]); // think
      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });
      if (turn.text) console.log(`🧠 ${turn.text}`);

      if (turn.toolCalls.length === 0) {
        console.log("\n✅ done");
        return;
      }

      const results: ToolResult[] = [];
      for (const call of turn.toolCalls) {
        if (call.name !== "run_code") continue;
        const code = String(call.input.code ?? "");
        console.log(`\n🛠  run_code:\n${indent(code)}`);

        let output = await session.runCode(code); // do

        // guard: screen untrusted tool output before it re-enters model context
        const verdict = await guard.screen(output, "input");
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
  } finally {
    await session.close();
    console.log(`✓ session stopped: ${session.id}`);
  }
}
