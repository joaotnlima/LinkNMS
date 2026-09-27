// The project dashboard + record surface's data layer, on `/api/v2` (LINA-326,
// S2 of the UI cutover, doc 22 §3). The pure transforms live in
// `./record-view.ts`; this module is the I/O and the fail-closed error handling,
// mirroring `./profile.ts` (S1) and `lib/api.ts` on the v1 side.
//
// ── WHAT CHANGED FROM v1 ─────────────────────────────────────────────────────
// The v1 record page read `lib/api.ts::getBuild` (identity, by email/party) +
// `getRecord` (the schedule service's B3 materials/money/history composite). v2
// is a different identity space (`identity.person`/`organization`, doc 22 §1),
// so the v1 reads 404 for a v2 project id. This swaps the header/identity onto
// the v2 project read and renders the empty / new-work record — the B2 shape
// (LINA-310): a project created on v2 has no baseline, no materials, no
// movements and no ledger yet, so "nothing recorded" is the norm, not an error.
//
// The record TABS populate from their own v2 module reads as those land (see
// `./record-view.ts` for the per-tab source map); the History tab specifically
// waits on the v2 Record ledger endpoint, which is documented but not yet
// registered. Until then `getRecordV2` returns the honest empty view rather than
// calling v1 — a v2 project has no v1 record to fetch.
import 'server-only';

import { v2, V2Error } from './client';
import { emptyRecordView, emptyDirectory, type V2Project } from './record-view';
import type { RecordView } from '@/lib/record';
import type { Directory } from '@/lib/view';

/** The build header/shell identity for a v2 project. */
export interface BuildV2 {
  id: string;
  name: string;
}

/**
 * GET /api/v2/projects/{id} → the build's identity for the record header and the
 * shell breadcrumb/switcher. Returns null when the viewer cannot read the project
 * (not a participant, or it does not exist): fail-closed, so the caller routes to
 * a neutral not-found rather than crashing or leaking a name (S1 pattern).
 */
export async function getBuildV2(id: string): Promise<BuildV2 | null> {
  try {
    const p = await v2<V2Project>({ method: 'GET', path: `/projects/${encodeURIComponent(id)}` });
    return { id: p.id, name: p.name };
  } catch (err) {
    if (err instanceof V2Error) return null; // not a participant / not found — no leak
    throw err;
  }
}

/**
 * The D14 record for a v2 project. Under B2 this is the empty / new-work view:
 * the surface's data source is cut off v1, and the composite tabs fill from their
 * own v2 module reads as those land (`./record-view.ts`). Returns the empty view
 * rather than reaching for v1 — a v2 project has no v1 record — so the existing
 * screen renders its honest empty states with no UI change.
 */
export async function getRecordV2(_id: string): Promise<RecordView> {
  return emptyRecordView();
}

/**
 * The actor directory for the record's Money/History attribution. Empty in the
 * S2 new-work shape (both tabs are empty); resolves for real when the History tab
 * reads `AuditEntry.actor` from the v2 Record ledger endpoint. Kept as its own
 * read so wiring it later is a one-line change here, not in the page.
 */
export async function getRecordDirectoryV2(_id: string): Promise<Directory> {
  return emptyDirectory();
}
