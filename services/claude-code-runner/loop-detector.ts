/**
 * loop-detector — the per-run inner bound (ADR-0037) that pairs with the run-count
 * quota (ADR-0036). `--max-turns` caps how MANY turns a run gets; the timeout caps
 * how LONG; neither catches a run that spends its whole budget *spinning* — issuing
 * the same tool call with the same input over and over (re-reading one file, re-running
 * one failing command, thrashing an edit). This catches that: N consecutive identical
 * tool calls ⇒ the run is stuck, kill it early rather than let it burn a quota slot.
 *
 * Signal choice (high precision, low false-positive): identical NAME *and* identical
 * INPUT, consecutively. An agent legitimately calls `bash`/`edit` many times with
 * DIFFERENT inputs — that's progress, not a loop — so keying on input is what keeps
 * this from firing on healthy runs.
 */

/** Deterministic key for a tool call — stable across object key ordering so
 *  {a,b} and {b,a} hash equal (the model may emit the same logical input either way). */
export function toolSignature(name: string, input: unknown): string {
  return `${name}:${stableStringify(input)}`;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export class LoopDetector {
  private last?: string;
  private count = 0;

  /** threshold = how many *consecutive* identical calls counts as a loop (default 5). */
  constructor(private readonly threshold = 5) {
    if (threshold < 2) throw new Error("LoopDetector threshold must be >= 2");
  }

  /** Record one tool call; returns a human-readable reason once the run is stuck in a
   *  loop, else undefined. Idempotent after tripping — keeps returning the reason. */
  record(name: string, input: unknown): string | undefined {
    const sig = toolSignature(name, input);
    if (sig === this.last) {
      this.count += 1;
    } else {
      this.last = sig;
      this.count = 1;
    }
    if (this.count >= this.threshold) {
      return `loop detected: '${name}' repeated ${this.count}× with identical input`;
    }
    return undefined;
  }
}
