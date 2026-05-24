/**
 * Pass-through ContentGuard — used when no guardrail is configured (no
 * GUARDRAIL_ID). Keeps guard wired into the loop without forcing a guardrail to
 * exist for the demo to run.
 */
import type { ContentGuard, GuardVerdict } from "../ports";

export class NoopContentGuard implements ContentGuard {
  readonly name = "noop";
  async screen(text: string): Promise<GuardVerdict> {
    return { intervened: false, blocked: false, text };
  }
}
