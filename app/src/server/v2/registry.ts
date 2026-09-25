// The one /api/v2 route table. Each module's http layer exports a
// `register(router)` and is mounted here — nowhere else — so this file is the
// complete answer to "what is live on v2" and stays diffable against
// cowork/documentation/api/v2/openapi.yaml.
import { createRouter } from '@platform/router.mjs';

let router: ReturnType<typeof createRouter> | null = null;

export function getRouter() {
  if (router) return router;
  router = createRouter();

  // Phase 0 ships the platform only; module registrations land phase by phase
  // (AGENT-INDEX §5):
  //   registerIdentity(router)     — phase 1
  //   registerProject(router)      — phase 2
  //   registerContracting(router)  — phases 3, 5
  //   registerPlanning(router)     — phase 4
  //   …

  return router;
}
