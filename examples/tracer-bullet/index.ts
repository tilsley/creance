/**
 * agent-os — tracer bullet (CLI entry).
 *
 * A thin consumer of @agent-os/core: build the building blocks from env, run the
 * loop once. Swap backends by env (INFERENCE_PROVIDER / SANDBOX_PROVIDER /
 * GUARDRAIL_ID / TELEMETRY) — see README. Requires AWS creds + Bedrock model
 * access in REGION unless you go fully local (ollama + local sandbox).
 */
import { runAgent, providersFromEnv } from "@agent-os/core";

const TASK =
  process.env.TASK ??
  "Compute the 25th Fibonacci number, then tell me whether it is prime. Use code.";

runAgent({ ...providersFromEnv(), task: TASK }).catch((err) => {
  console.error("\n— failed —");
  console.error(err?.name ? `${err.name}: ${err.message}` : err);
  const region = process.env.REGION ?? "eu-west-2";
  const hints: Record<string, string> = {
    AccessDeniedException:
      "IAM: needs bedrock:InvokeModel, bedrock:ApplyGuardrail + bedrock-agentcore:Start/Invoke/StopCodeInterpreterSession (see iam-policy.json).",
    ValidationException:
      `MODEL_ID may need a cross-region inference profile id (e.g. eu.anthropic.claude-...). List: aws bedrock list-inference-profiles --region ${region}`,
    ResourceNotFoundException:
      `Model/guardrail not found or legacy. Enable an ACTIVE model in the Bedrock console for ${region}, check GUARDRAIL_ID, or fix MODEL_ID.`,
  };
  if (err?.name && hints[err.name]) console.error(`\nhint: ${hints[err.name]}`);
  process.exit(1);
});
