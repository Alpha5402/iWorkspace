import { type CapabilityDefinition } from '@delivery/contracts';
import { Router } from 'express';

import { CapabilityNotImplementedError } from '../errors.js';

export function createCapabilityRouter(capability: CapabilityDefinition): Router {
  const router = Router();

  router.use((_request, _response, next) => {
    next(new CapabilityNotImplementedError(capability.id, capability.plannedPhase));
  });

  return router;
}
