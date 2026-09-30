// The Money surface's data layer, on `/api/v2` (LINA-381, Phase 12b.2 of the v1
// deprecation, doc 22 §3.3). The v2 replacement for the v1 budget read
// (`lib/api.ts::getBudgetMovement` + `getPlan`) that the standalone Money surface
// (`/projects/{id}/budget`) used to call. This module is ONLY the I/O and the
// fail-closed handling; the pure wire→view transforms + the money aggregation
// live in `./money-view.ts` so they stay unit-testable without a session, exactly
// as `record.ts`/`change-orders.ts` split from their `*-view.ts` counterparts.
//
// ── THREE REGISTERS, ALL FROM READS THAT ALREADY SHIPPED (S1–S7) ──────────────
// No new endpoint is minted here — doc 22 §3.3 authorised a project-scoped
// `record/money` projection, but every figure it would carry is already served,
// per-viewer-redacted, by reads that landed in the contracting/planning cutovers:
//   • Summary ← `GET /projects/{id}/contracts` + `GET /contracts/{id}/financials`
//   • Moves   ← `GET /projects/{id}/change-orders`   (LINA-357)
//   • Drift   ← `GET /projects/{id}/variations`
// Composing them here re-implements no visibility: each read is already redacted
// to what this viewer may see, and we only sum/sort numbers the server released.
// (The richer server-side `record/money` projection remains a tracked follow-on;
// this cutover unblocks the v1 drop without waiting on it.)
//
// Fail-closed exactly as S1/S4: a `V2Error` on any register (not mirrored, no
// active org, denied, or a contract we may see only in scope) is not a crash — it
// resolves to an empty register, so a viewer never sees another party's money and
// never a 500.
import 'server-only';

import { v2, V2Error } from './client';
import {
  buildMoneyView,
  type MoneyViewV2,
  type V2ProjectMoney,
  type V2Financials,
  type V2ContractRow,
  type V2Variation,
} from './money-view';
import { centsOf, type V2ChangeOrderRow } from './change-orders-view';
import type { V2Me } from './profile-view';

const enc = encodeURIComponent;

/** Read `/me` once; a viewer with no mirror row / no org resolves to null (not a
 *  crash) and the surface renders the neutral no-org state. */
async function readMe(): Promise<V2Me | null> {
  try {
    return await v2<V2Me>({ method: 'GET', path: '/me' });
  } catch (err) {
    if (err instanceof V2Error) return null; // not mirrored / no org
    throw err;
  }
}

/** A single read that falls closed to a default on any V2Error (denied / absent /
 *  no org) rather than failing the whole surface. */
async function readOr<T>(path: string, fallback: T): Promise<T> {
  try {
    return await v2<T>({ method: 'GET', path });
  } catch (err) {
    if (err instanceof V2Error) return fallback;
    throw err;
  }
}

/**
 * GET the Money surface for a v2 project, resolved for the current viewer, or
 * null when the viewer has no resolvable access to the project itself (not
 * mirrored / not a participant) — the page then renders the neutral empty
 * surface, never a leak.
 *
 * The financials fan-out runs only over the contracts the viewer sees in FULL: a
 * `scope`-visibility contract would 403 its financials, so we never ask. Each
 * financials read is still individually fail-closed in case a race changes access
 * between the list and the detail.
 */
export async function getMoneyV2(projectId: string): Promise<MoneyViewV2 | null> {
  const me = await readMe();
  if (!me?.active_org) {
    // Signed in but no active org: a first-class state, not an error. We still
    // report the project's indicative budget is unknown here (that read is
    // org-scoped too) — the surface says "select an organisation".
    return buildMoneyView({
      noActiveOrg: true,
      indicativeBudgetCents: null,
      financials: [],
      changeOrders: [],
      variations: [],
      me,
    });
  }

  let project: V2ProjectMoney;
  try {
    project = await v2<V2ProjectMoney>({ method: 'GET', path: `/projects/${enc(projectId)}` });
  } catch (err) {
    if (err instanceof V2Error) return null; // no access to the build → neutral empty surface
    throw err;
  }

  const [contractsPage, coPage, varPage] = await Promise.all([
    readOr<{ items: V2ContractRow[] }>(`/projects/${enc(projectId)}/contracts`, { items: [] }),
    readOr<{ items: V2ChangeOrderRow[] }>(`/projects/${enc(projectId)}/change-orders`, { items: [] }),
    readOr<{ items: V2Variation[] }>(`/projects/${enc(projectId)}/variations`, { items: [] }),
  ]);

  const fullContracts = (contractsPage.items ?? []).filter((c) => c._visibility === 'full');
  const financials = (
    await Promise.all(
      fullContracts.map((c) =>
        readOr<V2Financials | null>(`/contracts/${enc(c.id)}/financials`, null),
      ),
    )
  ).filter((f): f is V2Financials => f != null);

  return buildMoneyView({
    noActiveOrg: false,
    indicativeBudgetCents:
      project.indicative_budget ? centsOf(project.indicative_budget) : null,
    financials,
    changeOrders: coPage.items ?? [],
    variations: varPage.items ?? [],
    me,
  });
}
