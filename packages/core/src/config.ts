/**
 * The ports/adapters seam as config (ADR-0003): build the four building blocks
 * from environment variables. Shared by the example CLI and the services so
 * there's one wiring, not a copy per consumer.
 *
 * Call ONCE per process — the OTel telemetry sink registers a global provider.
 */
import { BedrockInferenceProvider } from "./adapters/bedrock-inference";
import { OllamaInferenceProvider } from "./adapters/ollama-inference";
import { AgentCoreSandboxProvider } from "./adapters/agentcore-sandbox";
import { LocalSandboxProvider } from "./adapters/local-sandbox";
import { BedrockContentGuard } from "./adapters/bedrock-guard";
import { NoopContentGuard } from "./adapters/noop-guard";
import { ConsoleTelemetrySink } from "./adapters/console-telemetry";
import { OtelTelemetrySink } from "./adapters/otel-telemetry";
import { LocalGate } from "./adapters/local-gate";
import { NoopGate } from "./adapters/noop-gate";
import type { InferenceProvider, SandboxProvider, ContentGuard, TelemetrySink } from "./ports";
import type { Gate } from "./gate";

export interface Providers {
  inference: InferenceProvider;
  sandbox: SandboxProvider;
  guard: ContentGuard;
  telemetry: TelemetrySink;
  gate: Gate;
}

type Env = Record<string, string | undefined>;

export function providersFromEnv(env: Env = process.env): Providers {
  const region = env.REGION ?? "eu-west-2";

  const inference: InferenceProvider = (() => {
    switch (env.INFERENCE_PROVIDER ?? "bedrock") {
      case "bedrock":
        return new BedrockInferenceProvider(env.MODEL_ID ?? "amazon.nova-lite-v1:0", region);
      case "ollama":
        return new OllamaInferenceProvider(env.OLLAMA_MODEL ?? "llama3.1", env.OLLAMA_HOST);
      default:
        throw new Error(`unknown INFERENCE_PROVIDER: ${env.INFERENCE_PROVIDER}`);
    }
  })();

  const sandbox: SandboxProvider = (() => {
    switch (env.SANDBOX_PROVIDER ?? "agentcore") {
      case "agentcore":
        return new AgentCoreSandboxProvider(
          env.CODE_INTERPRETER_ID ?? "aws.codeinterpreter.v1",
          region,
          env.AGENTCORE_ENDPOINT,
        );
      case "local":
        return new LocalSandboxProvider(); // ⚠ DEMO ONLY — runs code on host, no isolation
      default:
        throw new Error(`unknown SANDBOX_PROVIDER: ${env.SANDBOX_PROVIDER}`);
    }
  })();

  const guard: ContentGuard = env.GUARDRAIL_ID
    ? new BedrockContentGuard(env.GUARDRAIL_ID, env.GUARDRAIL_VERSION ?? "DRAFT", region)
    : new NoopContentGuard();

  const telemetry: TelemetrySink = (() => {
    switch (env.TELEMETRY ?? "console") {
      case "console":
        return new ConsoleTelemetrySink();
      case "otel":
        return new OtelTelemetrySink();
      default:
        throw new Error(`unknown TELEMETRY: ${env.TELEMETRY}`);
    }
  })();

  // gate defaults to open (noop) so direct loop consumers are unaffected; the
  // runtime opts into token auth + budget via GATE=local (ADR-0009).
  const gate: Gate =
    (env.GATE ?? "noop") === "local" ? new LocalGate(env.GATE_TOKENS, env.GATE_BUDGET_USD) : new NoopGate();

  return { inference, sandbox, guard, telemetry, gate };
}
