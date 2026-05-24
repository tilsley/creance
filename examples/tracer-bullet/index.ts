/**
 * agent-os — tracer bullet (entry point)
 *
 * Wires config → adapters → the backend-agnostic loop. The ports/adapters seam
 * (ADR-0003) lives here: swap providers by env without touching loop.ts.
 *
 *   bun install && bun run start
 *
 * Requires AWS creds + Bedrock model access in REGION (see README).
 */
import { runAgent } from "./loop";
import { BedrockInferenceProvider } from "./adapters/bedrock-inference";
import { AgentCoreSandboxProvider } from "./adapters/agentcore-sandbox";
import type { InferenceProvider, SandboxProvider } from "./ports";

const REGION = process.env.REGION ?? "eu-west-2";
const MODEL_ID = process.env.MODEL_ID ?? "amazon.nova-lite-v1:0";
const INTERPRETER_ID = process.env.CODE_INTERPRETER_ID ?? "aws.codeinterpreter.v1";
const TASK =
  process.env.TASK ??
  "Compute the 25th Fibonacci number, then tell me whether it is prime. Use code.";

// --- the ports/adapters seam: pick implementations by config -----------------
function makeInference(): InferenceProvider {
  const provider = process.env.INFERENCE_PROVIDER ?? "bedrock";
  switch (provider) {
    case "bedrock":
      return new BedrockInferenceProvider(MODEL_ID, REGION);
    // case "ollama": return new OllamaInferenceProvider(...);  // future adapter
    default:
      throw new Error(`unknown INFERENCE_PROVIDER: ${provider}`);
  }
}

function makeSandbox(): SandboxProvider {
  const provider = process.env.SANDBOX_PROVIDER ?? "agentcore";
  switch (provider) {
    case "agentcore":
      return new AgentCoreSandboxProvider(INTERPRETER_ID, REGION, process.env.AGENTCORE_ENDPOINT);
    // case "local": return new LocalSandboxProvider(...);       // future adapter
    default:
      throw new Error(`unknown SANDBOX_PROVIDER: ${provider}`);
  }
}

runAgent({ inference: makeInference(), sandbox: makeSandbox(), task: TASK }).catch((err) => {
  console.error("\n— failed —");
  console.error(err?.name ? `${err.name}: ${err.message}` : err);
  const hints: Record<string, string> = {
    AccessDeniedException:
      "IAM: needs bedrock:InvokeModel + bedrock-agentcore:Start/Invoke/StopCodeInterpreterSession (see iam-policy.json).",
    ValidationException:
      `MODEL_ID may need a cross-region inference profile id (e.g. eu.anthropic.claude-...). List: aws bedrock list-inference-profiles --region ${REGION}`,
    ResourceNotFoundException:
      `Model not enabled or legacy. Enable an ACTIVE model in the Bedrock console for ${REGION}, or fix MODEL_ID.`,
  };
  if (err?.name && hints[err.name]) console.error(`\nhint: ${hints[err.name]}`);
  process.exit(1);
});
