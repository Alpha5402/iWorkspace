import { capabilities, createOpenApiDocument, HealthResponseSchema } from '@delivery/contracts';
import { type ReadinessProbe } from '@delivery/health';
import { type Logger } from 'pino';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { createRequestContextMiddleware, getResponseTraceId } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createCapabilityRouter } from './modules/capabilityRouter.js';

type CreateAppOptions = Readonly<{
  logger: Logger;
  readinessProbe: ReadinessProbe;
  serviceName: string;
}>;

export function createApp(options: CreateAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(createRequestContextMiddleware(options.serviceName));
  app.use(
    pinoHttp({
      logger: options.logger,
      redact: ['req.headers.authorization'],
    }),
  );

  app.get('/health/live', (_request, response) => {
    response.status(200).json(
      HealthResponseSchema.parse({
        service: options.serviceName,
        status: 'ok',
        traceId: getResponseTraceId(response.locals),
      }),
    );
  });

  app.get('/health/ready', async (_request, response) => {
    const readiness = await options.readinessProbe.check();
    const status = readiness.ready ? 'ok' : 'degraded';
    response.status(readiness.ready ? 200 : 503).json(
      HealthResponseSchema.parse({
        dependencies: readiness.dependencies,
        service: options.serviceName,
        status,
        traceId: getResponseTraceId(response.locals),
      }),
    );
  });

  app.get('/api/v1/openapi.json', (_request, response) => {
    response.status(200).json(createOpenApiDocument());
  });

  for (const capability of capabilities) {
    app.use(`/api/v1${capability.path}`, createCapabilityRouter(capability));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
