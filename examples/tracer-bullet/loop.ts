/**
 * The L1 agent loop — depends ONLY on the ports (ADR-0003). It has no idea
 * whether `think` is Bedrock or Ollama, or whether `do` is AgentCore or local.
 */
import type {
  InferenceProvider,
  SandboxProvider,
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
  task: string;
  maxSteps?: number;
}

export async function runAgent({ inference, sandbox, task, maxSteps = 8 }: RunOpts): Promise<void> {
  console.log(`▶ inference=${inference.name}  sandbox=${sandbox.name}`);
  console.log(`▶ task: ${task}\n`);

  const session = await sandbox.startSession();
  console.log(`✓ sandbox session: ${session.id}\n`);

  const messages: Message[] = [{ role: "user", text: task }];

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
        const output = await session.runCode(code); // do
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
