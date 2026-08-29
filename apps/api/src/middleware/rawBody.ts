import { type IncomingMessage, type ServerResponse } from 'node:http';

import { type Request } from 'express';

const rawBodies = new WeakMap<object, Buffer>();

export function preserveRawBody(
  request: IncomingMessage,
  _response: ServerResponse,
  body: Buffer,
): void {
  void _response;
  rawBodies.set(request, Buffer.from(body));
}

export function getRawBody(request: Request): Buffer | undefined {
  return rawBodies.get(request);
}
