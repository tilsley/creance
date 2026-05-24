/**
 * agent-os — tracer bullet
 *
 * The thinnest vertical slice through the architecture: a minimal L1 agent loop
 * (see docs/runtime.md) composing the two core *acting* primitives —
 *
 *   think → Amazon Bedrock (Converse API)
 *   do    → AgentCore Code Interpreter (a Firecracker microVM per session)
 *
 * The model gets ONE tool, `run_code`. When it calls the tool we execute the code
 * in an AgentCore session and feed the result back. Loop until the model is done.
 *
 *   bun install && bun run start
 *
 * Requires AWS creds + Bedrock model access in REGION (see README).
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockAgentCoreClient,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const REGION = process.env.REGION ?? "eu-west-2";
// Amazon Nova Lite: active + on-demand in eu-west-2, cheap, supports tool use.
// Better tool-calling: enable Claude Haiku 4.5 access, set
// MODEL_ID=eu.anthropic.claude-haiku-4-5-20251001-v1:0 (inference profile).
const MODEL_ID = process.env.MODEL_ID ?? "amazon.nova-lite-v1:0";
const CODE_INTERPRETER_ID = process.env.CODE_INTERPRETER_ID ?? "aws.codeinterpreter.v1";
const TASK =
  process.env.TASK ??
  "Compute the 25th Fibonacci number, then tell me whether it is prime. Use code.";

const indent = (s: string) =>
  s.split("\n").map((l) => "    " + l).join("\n");

const bedrock = new BedrockRuntimeClient({ region: REGION });
const agentcore = new BedrockAgentCoreClient({
  region: REGION,
  endpoint: process.env.AGENTCORE_ENDPOINT, // optional override; undefined = SDK default
});

// The one tool the agent can call.
const runCodeTool: Tool = {
  toolSpec: {
    name: "run_code",
    description:
      "Execute Python code in a secure sandbox and return its stdout. Use this for any computation.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python source to execute." },
        },
        required: ["code"],
      },
    },
  },
};

// do: run code in an AgentCore Code Interpreter session, collect stdout.
async function runCode(sessionId: string, code: string): Promise<string> {
  const res = await agentcore.send(
    new InvokeCodeInterpreterCommand({
      codeInterpreterIdentifier: CODE_INTERPRETER_ID,
      sessionId,
      name: "executeCode",
      arguments: { language: "python", code },
    }),
  );
  let out = "";
  for await (const event of res.stream ?? []) {
    const result = (event as any).result;
    for (const item of result?.content ?? []) {
      if (item.type === "text" && item.text) out += item.text;
    }
  }
  return out.trim() || "(no output)";
}

async function main() {
  console.log(`▶ region=${REGION}  model=${MODEL_ID}`);
  console.log(`▶ task: ${TASK}\n`);

  const session = await agentcore.send(
    new StartCodeInterpreterSessionCommand({
      codeInterpreterIdentifier: CODE_INTERPRETER_ID,
      name: "tracer-bullet",
      sessionTimeoutSeconds: 900,
    }),
  );
  const sessionId = session.sessionId!;
  console.log(`✓ sandbox session: ${sessionId}\n`);

  const messages: Message[] = [{ role: "user", content: [{ text: TASK }] }];

  try {
    for (let step = 1; step <= 8; step++) {
      // think
      const resp = await bedrock.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          messages,
          toolConfig: { tools: [runCodeTool] },
        }),
      );
      const msg = resp.output?.message;
      if (msg) messages.push(msg);

      for (const block of msg?.content ?? []) {
        if (block.text) console.log(`🧠 ${block.text}`);
      }

      if (resp.stopReason !== "tool_use") {
        console.log("\n✅ done");
        return;
      }

      // do: execute each tool call, feed results back to the model
      const toolResults: any[] = [];
      for (const block of msg?.content ?? []) {
        if (!block.toolUse) continue;
        const { toolUseId, name, input } = block.toolUse;
        if (name !== "run_code") continue;
        const code = (input as any).code as string;
        console.log(`\n🛠  run_code:\n${indent(code)}`);
        const output = await runCode(sessionId, code);
        console.log(`📤 output:\n${indent(output)}\n`);
        toolResults.push({
          toolResult: {
            toolUseId,
            content: [{ text: output }],
            status: "success",
          },
        });
      }
      messages.push({ role: "user", content: toolResults });
    }
    console.log("\n⚠ hit step limit (8)");
  } finally {
    await agentcore
      .send(
        new StopCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: CODE_INTERPRETER_ID,
          sessionId,
        }),
      )
      .catch(() => {});
    console.log(`✓ session stopped: ${sessionId}`);
  }
}

main().catch((err) => {
  console.error("\n— failed —");
  console.error(err?.name ? `${err.name}: ${err.message}` : err);
  const hints: Record<string, string> = {
    AccessDeniedException:
      "IAM: your principal needs bedrock:InvokeModel + bedrock-agentcore:StartCodeInterpreterSession/InvokeCodeInterpreter/StopCodeInterpreterSession.",
    ValidationException:
      `MODEL_ID may need a cross-region inference profile id (e.g. eu.anthropic.claude-...). List: aws bedrock list-inference-profiles --region ${REGION}`,
    ResourceNotFoundException:
      `Model not enabled. Turn on Claude model access in the Bedrock console for ${REGION}, or fix MODEL_ID.`,
  };
  if (err?.name && hints[err.name]) console.error(`\nhint: ${hints[err.name]}`);
  process.exit(1);
});
