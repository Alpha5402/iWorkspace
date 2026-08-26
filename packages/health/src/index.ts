import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';

export type DependencyStatus = Readonly<{
  name: string;
  status: 'up' | 'down';
}>;

export interface DependencyProbe {
  readonly name: string;
  check(): Promise<DependencyStatus>;
  close?(): Promise<void>;
}

export type ReadinessResult = Readonly<{
  dependencies: Readonly<Record<string, Readonly<{ status: 'up' | 'down' }>>>;
  ready: boolean;
}>;

export interface ReadinessProbe {
  check(): Promise<ReadinessResult>;
  close(): Promise<void>;
}

export function createReadinessProbe(probes: readonly DependencyProbe[]): ReadinessProbe {
  return {
    async check() {
      const statuses = await Promise.all(probes.map(async (probe) => probe.check()));
      const dependencies = Object.fromEntries(
        statuses.map(({ name, status }) => [name, { status }]),
      );

      return {
        dependencies,
        ready: statuses.every(({ status }) => status === 'up'),
      };
    },
    async close() {
      await Promise.all(probes.map(async (probe) => probe.close?.()));
    },
  };
}

type ProcessHealthServerOptions = Readonly<{
  host: string;
  port: number;
  readinessProbe: ReadinessProbe;
  service: string;
  startSpan?: (name: string, headers: IncomingHttpHeaders) => ProcessServerSpan;
}>;

export type ProcessServerSpan = Readonly<{
  end(statusCode: number): void;
  traceId: string;
}>;

export type ProcessHealthResponse = Readonly<{
  body: Readonly<Record<string, unknown>>;
  statusCode: number;
}>;

export function createProcessHealthServer(options: ProcessHealthServerOptions): Server {
  return createServer((request, response) => {
    const span = options.startSpan?.(
      `${request.method ?? 'UNKNOWN'} ${request.url ?? '/'}`,
      request.headers,
    );
    if (span !== undefined) {
      response.setHeader('x-trace-id', span.traceId);
      response.once('finish', () => {
        span.end(response.statusCode);
      });
    }
    void handleHealthRequest(options, request.url, response, span?.traceId);
  });
}

async function handleHealthRequest(
  options: ProcessHealthServerOptions,
  requestUrl: string | undefined,
  response: ServerResponse,
  traceId: string | undefined,
): Promise<void> {
  const result = await evaluateProcessHealthRequest(options, requestUrl);
  response.setHeader('content-type', 'application/json');
  response.statusCode = result.statusCode;
  response.end(JSON.stringify(traceId === undefined ? result.body : { ...result.body, traceId }));
}

export async function evaluateProcessHealthRequest(
  options: ProcessHealthServerOptions,
  requestUrl: string | undefined,
): Promise<ProcessHealthResponse> {
  if (requestUrl === '/health/live') {
    return { body: { service: options.service, status: 'ok' }, statusCode: 200 };
  }

  if (requestUrl === '/health/ready') {
    try {
      const readiness = await options.readinessProbe.check();
      return {
        body: {
          dependencies: readiness.dependencies,
          service: options.service,
          status: readiness.ready ? 'ok' : 'degraded',
        },
        statusCode: readiness.ready ? 200 : 503,
      };
    } catch {
      return {
        body: { service: options.service, status: 'degraded' },
        statusCode: 503,
      };
    }
  }

  return {
    body: { code: 'NOT_FOUND', service: options.service },
    statusCode: 404,
  };
}
