/**
 * OpenTelemetry TelemetrySink — emits real spans. OTel is itself the neutral
 * layer: this adapter is the SDK side; the *exporter* is the swap point.
 *   - no OTEL_EXPORTER_OTLP_ENDPOINT  → ConsoleSpanExporter (prints spans)
 *   - OTEL_EXPORTER_OTLP_ENDPOINT set → OTLP (→ local Jaeger, or in prod the
 *     in-cluster ADOT collector → OpenSearch + S3). App code is identical; only
 *     the endpoint changes.
 */
import { trace, diag, DiagConsoleLogger, DiagLogLevel, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { TelemetrySink, TelemetrySpan } from "../ports";

export class OtelTelemetrySink implements TelemetrySink {
  readonly name = "otel";
  private tracer: Tracer;
  private provider: NodeTracerProvider;

  constructor(serviceName = "agent-os") {
    const exporter = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? new OTLPTraceExporter()
      : new ConsoleSpanExporter();
    // Export failures are SILENT unless a diag logger is registered — a wrong
    // OTLP endpoint/auth would otherwise drop every span with no trace in the
    // task logs (ADR-0035, learned the hard way).
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);
    // SimpleSpanProcessor exports on each span end — correct for a short-lived
    // CLI run (Batch would buffer and lose spans on exit). Long-lived services
    // would use BatchSpanProcessor + provider.shutdown() on SIGTERM.
    this.provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ "service.name": serviceName }),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    this.provider.register();
    this.tracer = trace.getTracer(serviceName);
  }

  /** Flush in-flight exports (each span's HTTP POST is async — the root span's is
   *  still in the air when a task-per-run finishes). Callers bound this with a
   *  timeout; a hung flush must never keep a paid task alive (ADR-0031/0035). */
  async shutdown(): Promise<void> {
    await this.provider.shutdown();
  }

  run<T>(attrs: Record<string, unknown>, fn: (span: TelemetrySpan) => Promise<T>): Promise<T> {
    return this.span("agent.run", attrs, fn);
  }

  step<T>(name: string, attrs: Record<string, unknown>, fn: (span: TelemetrySpan) => Promise<T>): Promise<T> {
    return this.span(name, attrs, fn);
  }

  private span<T>(
    name: string,
    attrs: Record<string, unknown>,
    fn: (span: TelemetrySpan) => Promise<T>,
  ): Promise<T> {
    // startActiveSpan nests children under the current run automatically.
    return this.tracer.startActiveSpan(name, async (otelSpan) => {
      otelSpan.setAttributes(attrs as Record<string, any>);
      const span: TelemetrySpan = { setAttrs: (a) => otelSpan.setAttributes(a as Record<string, any>) };
      try {
        return await fn(span);
      } catch (e: any) {
        otelSpan.recordException(e);
        otelSpan.setStatus({ code: SpanStatusCode.ERROR });
        throw e;
      } finally {
        otelSpan.end();
      }
    });
  }
}
