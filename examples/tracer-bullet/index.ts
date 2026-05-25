/**
 * agent-os — tracer bullet (entry point)
 *
 * Wires config → adapters → the backend-agnostic loop. The ports/adapters seam
 * (ADR-0003) lives here: swap providers/controls by env without touching loop.ts.
 *
 *   bun install && bun run start
 *
 * Requires AWS creds + Bedrock model access in REGION (see README). `guard` is a
 * no-op until GUARDRAIL_ID is set; `record` prints to console unless TELEMETRY=otel.
 */
import {
  runAgent,
  BedrockInferenceProvider,
  OllamaInferenceProvider,
  AgentCoreSandboxProvider,
  LocalSandboxProvider,
  BedrockContentGuard,
  NoopContentGuard,
  ConsoleTelemetrySink,
  OtelTelemetrySink,
  type InferenceProvider,
  type SandboxProvider,
  type ContentGuard,
  type TelemetrySink,
} from "@agent-os/core";

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
    case "ollama":
      return new OllamaInferenceProvider(process.env.OLLAMA_MODEL ?? "llama3.1", process.env.OLLAMA_HOST);
    default:
      throw new Error(`unknown INFERENCE_PROVIDER: ${provider}`);
  }
}

function makeSandbox(): SandboxProvider {
  const provider = process.env.SANDBOX_PROVIDER ?? "agentcore";
  switch (provider) {
    case "agentcore":
      return new AgentCoreSandboxProvider(INTERPRETER_ID, REGION, process.env.AGENTCORE_ENDPOINT);
    case "local":
      return new LocalSandboxProvider(); // ⚠ DEMO ONLY — runs code on host, no isolation
    default:
      throw new Error(`unknown SANDBOX_PROVIDER: ${provider}`);
  }
}

function makeGuard(): ContentGuard {
  const id = process.env.GUARDRAIL_ID;
  if (!id) return new NoopContentGuard(); // guard off until a guardrail is configured
  return new BedrockContentGuard(id, process.env.GUARDRAIL_VERSION ?? "DRAFT", REGION);
}

function makeTelemetry(): TelemetrySink {
  const sink = process.env.TELEMETRY ?? "console";
  switch (sink) {
    case "console":
      return new ConsoleTelemetrySink();
    case "otel":
      return new OtelTelemetrySink(); // console span exporter, or OTLP if endpoint set
    default:
      throw new Error(`unknown TELEMETRY: ${sink}`);
  }
}

runAgent({
  inference: makeInference(),
  sandbox: makeSandbox(),
  guard: makeGuard(),
  telemetry: makeTelemetry(),
  task: TASK,
}).catch((err) => {
  console.error("\n— failed —");
  console.error(err?.name ? `${err.name}: ${err.message}` : err);
  const hints: Record<string, string> = {
    AccessDeniedException:
      "IAM: needs bedrock:InvokeModel, bedrock:ApplyGuardrail + bedrock-agentcore:Start/Invoke/StopCodeInterpreterSession (see iam-policy.json).",
    ValidationException:
      `MODEL_ID may need a cross-region inference profile id (e.g. eu.anthropic.claude-...). List: aws bedrock list-inference-profiles --region ${REGION}`,
    ResourceNotFoundException:
      `Model/guardrail not found or legacy. Enable an ACTIVE model in the Bedrock console for ${REGION}, check GUARDRAIL_ID, or fix MODEL_ID.`,
  };
  if (err?.name && hints[err.name]) console.error(`\nhint: ${hints[err.name]}`);
  process.exit(1);
});
