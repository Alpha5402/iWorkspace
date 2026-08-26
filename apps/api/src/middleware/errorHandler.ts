import { ErrorResponseSchema, type ErrorResponse } from '@delivery/contracts';
import { type ErrorRequestHandler, type RequestHandler } from 'express';

import { CapabilityNotImplementedError, HttpError } from '../errors.js';
import { getResponseTraceId } from './requestContext.js';

export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new HttpError(404, 'NOT_FOUND', 'The requested resource does not exist.'));
};

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next;
  const traceId = getResponseTraceId(response.locals);
  const httpError = error instanceof HttpError ? error : undefined;
  const status = httpError?.status ?? 500;

  const payload: ErrorResponse = {
    error: {
      code: httpError?.code ?? 'INTERNAL_ERROR',
      message: httpError?.message ?? 'An unexpected error occurred.',
      traceId,
      ...(error instanceof CapabilityNotImplementedError
        ? {
            capability: error.capability,
            plannedPhase: error.plannedPhase,
          }
        : {}),
    },
  };

  response.status(status).json(ErrorResponseSchema.parse(payload));
};
