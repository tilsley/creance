/**
 * Bedrock Guardrails adapter for the ContentGuard control port (guard, ADR-0008).
 * Uses ApplyGuardrail — screens content independently of model invocation, so it
 * works for model I/O AND untrusted tool/RAG output.
 */
import {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { ContentGuard, GuardDirection, GuardVerdict } from "../ports";

export class BedrockContentGuard implements ContentGuard {
  readonly name = "bedrock-guardrails";
  private client: BedrockRuntimeClient;

  constructor(
    private guardrailId: string,
    private guardrailVersion: string,
    region: string,
  ) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async screen(text: string, direction: GuardDirection): Promise<GuardVerdict> {
    const res = await this.client.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: this.guardrailId,
        guardrailVersion: this.guardrailVersion,
        source: direction === "input" ? "INPUT" : "OUTPUT",
        content: [{ text: { text } }],
      }),
    );
    const intervened = res.action === "GUARDRAIL_INTERVENED";
    // outputs[] carries the masked / replacement text when the guardrail acts.
    const masked = res.outputs?.[0]?.text;
    return { intervened, blocked: intervened, text: masked ?? text };
  }
}
