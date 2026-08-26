import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import pino, { type Logger } from 'pino';

const redactedPaths = [
  'authorization',
  'password',
  'token',
  'secret',
  'req.headers.authorization',
  '*.password',
  '*.token',
  '*.secret',
];

export function createLogger(service: string, level: string): Logger {
  return pino({
    base: { service },
    level,
    redact: {
      censor: '[REDACTED]',
      paths: redactedPaths,
    },
  });
}

export type TelemetryHandle = Readonly<{
  shutdown(): Promise<void>;
}>;

export function startTelemetry(serviceName: string, endpoint: string): TelemetryHandle {
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
  });
  sdk.start();

  return {
    async shutdown() {
      await sdk.shutdown();
    },
  };
}

export function getTracer(service: string): Tracer {
  return trace.getTracer(service);
}

export type ServerSpan = Readonly<{
  end(statusCode: number): void;
  traceId: string;
}>;

export function startServerSpan(
  service: string,
  name: string,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): ServerSpan {
  const parentContext = propagation.extract(context.active(), headers);
  const span = getTracer(service).startSpan(name, { kind: SpanKind.SERVER }, parentContext);

  return {
    end(statusCode) {
      span.setAttribute('http.response.status_code', statusCode);
      if (statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    },
    traceId: span.spanContext().traceId,
  };
}
