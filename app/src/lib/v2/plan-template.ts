// The plan template's v2 I/O layer, on `/api/v2` (LINA-383, phase 12b.4 of the
// UI cutover). This is the READ side of the plan-authoring template cutover off
// v1 `/me/plan-template`: it resolves the caller's applicable default scaffold
// (personal default → library/system default) through the shared v2 client
// (`./client.ts`, LINA-309) and hands the editor the names-only body it copies
// into a fresh draft (copy-not-link, LINA-241).
//
// ── FIRST-CLASS EMPTY / NO-ORG STATES (doc 22 header) ─────────────────────────
// A plan template is a USER preference, not project data — the v2 endpoint gates
// on the identity mirror only, never an active org, so a signed-in user resolves
// their default whether or not an org is picked. But a viewer whose mirror has
// not caught up (personId still null) gets a 401; that (like any V2Error) must
// NOT crash the plan page — it degrades to the built-in skeleton, exactly as the
// v1 editor did. A non-V2 error (a real bug) is rethrown.
import 'server-only';

import { v2, V2Error } from './client';
import type { TemplatePhase } from '@/lib/plan-authoring';

/** GET /me/plan-template — the resolved default plus its provenance (v1 shape). */
interface ResolvedPlanTemplateWire {
  source: 'user' | 'system';
  body: TemplatePhase[];
  template: {
    id: string;
    ownerScope: 'user' | 'org' | 'system';
    name: string;
    isDefault: boolean;
    updatedAt: string;
  };
}

/**
 * The caller's default plan scaffold (names only), fail-closed. An unreachable or
 * unauthorized template resolves to `undefined` so the editor still opens, seeded
 * from its built-in skeleton — a user preference read never blocks authoring.
 */
export async function getDefaultTemplateBody(): Promise<TemplatePhase[] | undefined> {
  try {
    const resolved = await v2<ResolvedPlanTemplateWire>({
      method: 'GET',
      path: '/me/plan-template',
    });
    return resolved.body?.length ? resolved.body : undefined;
  } catch (err) {
    if (err instanceof V2Error) return undefined; // no mirror / unreachable — not a crash
    throw err;
  }
}
