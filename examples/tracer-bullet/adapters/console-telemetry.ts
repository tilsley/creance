/**
 * Default TelemetrySink — structured console output, zero dependencies, no SDK.
 * Lets the loop run with `record` wired in without standing up any OTel infra.
 */
import type { TelemetrySink, TelemetrySpan } from "../ports";

export class ConsoleTelemetrySink implements TelemetrySink {
  readonly name = "console";

  run<T>(attrs: Record<string, unknown>, fn: (span: TelemetrySpan) => Promise<T>): Promise<T> {
    return this.span("agent.run", attrs, fn);
  }

  step<T>(name: string, attrs: Record<string, unknown>, fn: (span: TelemetrySpan) => Promise<T>): Promise<T> {
    return this.span(name, attrs, fn);
  }

  private async span<T>(
    name: string,
    attrs: Record<string, unknown>,
    fn: (span: TelemetrySpan) => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    const collected: Record<string, unknown> = { ...attrs };
    const span: TelemetrySpan = { setAttrs: (a) => Object.assign(collected, a) };
    try {
      return await fn(span);
    } finally {
      const ms = Math.round(performance.now() - start);
      const tags = Object.keys(collected).length ? " " + JSON.stringify(collected) : "";
      console.log(`📊 ${name} ${ms}ms${tags}`);
    }
  }
}
