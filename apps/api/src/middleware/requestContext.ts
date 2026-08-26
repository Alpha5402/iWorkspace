import { randomUUID } from 'node:crypto';

import { startServerSpan } from '@delivery/observability';
import { type RequestHandler } from 'express';

const requestIdHeader = 'x-request-id';
const traceIdHeader = 'x-trace-id';

export function createRequestContextMiddleware(serviceName: string): RequestHandler {
  return (request, response, next) => {
    const suppliedRequestId = request.header(requestIdHeader);
    const requestId =
      suppliedRequestId !== undefined && suppliedRequestId.length <= 128
        ? suppliedRequestId
        : randomUUID();

    const span = startServerSpan(serviceName, `${request.method} ${request.path}`, request.headers);
    response.locals.requestId = requestId;
    response.locals.traceId = span.traceId;
    response.setHeader(requestIdHeader, requestId);
    response.setHeader(traceIdHeader, span.traceId);
    response.once('finish', () => {
      span.end(response.statusCode);
    });
    next();
  };
}

export function getResponseTraceId(locals: Record<string, unknown>): string {
  return typeof locals.traceId === 'string' && locals.traceId.length > 0
    ? locals.traceId
    : 'unavailable';
}
