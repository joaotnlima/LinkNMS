// Pure v2-wire → view transforms for the project dashboard + record surface
// (LINA-326, S2 of the UI cutover, doc 22 §3). The I/O twin is `./record.ts`;
// this half is the mapping, unit-testable without a Clerk session or a router —
// exactly as `lib/view.ts` is the pure counterpart to `lib/api.ts` on v1, and
// `./profile-view.ts` is to `./profile.ts` on the S1 v2 path.
//
// ── WHAT S2 CUTS, AND WHAT IT DELIBERATELY LEAVES EMPTY ──────────────────────
// The record surface (D14) is a COMPOSITE: its Plan/Schedule tabs are a planning
// read, its Money tab a contracting read, its History tab the append-only ledger
// (`record.audit_event`). Under Gate B = B2 (fresh start, LINA-310) a project
// created on v2 has none of these yet, so the honest S2 target is the
// empty / new-work shape — which the existing screen already renders well
// ("No baseline yet", "No plan lines yet", "Nothing has been recorded yet").
//
// So this slice swaps the surface's DATA SOURCE off the v1 in-process handlers
// (which 404 for a v2 project id — different identity space, doc 22 §1) and onto
// the v2 project read, rendering the empty record. POPULATING the tabs is not a
// transform change here; each tab fills from its own v2 module read as those
// land:
//   • Plan / Schedule  ← planning module (S3, doc 05 shapes)
//   • Money            ← contracting financials / change-orders (S4)
//   • History          ← the v2 Record ledger endpoint (`GET /projects/{id}/record`),
//                        which is documented in openapi but NOT YET registered and
//                        has no writers wired (`record.append_event` is schema-only).
//                        Tracked as the backend follow-up that fills this tab.
// Building the empty view HERE (not in the page) keeps the "what fills each tab,
// and from where" contract in one tested place instead of smeared across JSX.
import type { Directory } from '@/lib/view';
import type { RecordView } from '@/lib/record';
import type { OperatingModel } from '@/lib/types';

// ── The v2 wire shapes we read (subset) ──────────────────────────────────────
// Verbatim against modules/project use-case `projectBody`/`participantBody` and
// cowork/documentation/api/v2/openapi.yaml (schemas Project, Participant). A
// local restatement is what makes a contract drift a type error here rather than
// `undefined` under a field on the screen — the same discipline as lib/view.ts.

export interface V2Money {
  amount_cents: number;
  currency: string;
}

export type V2ProjectStatus =
  | 'draft' | 'tendering' | 'contracted' | 'in_execution' | 'closed' | 'cancelled';

/** `GET /api/v2/projects/{id}` → Project. The dashboard/record header identity. */
export interface V2Project {
  id: string;
  name: string;
  address?: string;
  municipality_code: string;
  typology?: string;
  gross_area_m2?: number;
  indicative_budget?: V2Money;
  owner_org_id?: string;
  status: V2ProjectStatus;
  operating_model?: 'undetermined' | OperatingModel;
  version?: number;
}

export type V2Capacity =
  | 'owner' | 'prime_contractor' | 'direct_contractor' | 'subcontractor' | 'consultant';

export interface V2ParticipantOrg {
  id: string;
  kind: string;
  legal_name: string;
  nif?: string;
}

export interface V2Participant {
  org: V2ParticipantOrg;
  capacity: V2Capacity;
  source: 'project' | 'contract' | 'invitation';
  contract_id?: string;
  invite_capacity?: string;
}

export interface V2ParticipantList {
  items: V2Participant[];
  next_cursor?: string | null;
}

// ── The empty / new-work record ──────────────────────────────────────────────

/**
 * The record of a project with nothing recorded against it yet — the B2
 * new-work shape. `baseline: null` is the load-bearing field: the header renders
 * "No baseline yet — nothing here is agreed until a plan is accepted" off it, and
 * every tab renders its own empty notice off the empty arrays. `state` is
 * `accepted` (tone neutral, label "As agreed") to match the v1 empty record; the
 * baseline-null header, not the badge, is what states "nothing is agreed yet",
 * so this never claims an agreement that has not happened (view.ts rule 2).
 */
export function emptyRecordView(): RecordView {
  return {
    state: 'accepted',
    baseline: null,
    tabs: {
      plan: { lines: [] },
      schedule: { lines: [] },
      money: {
        baselineBudgetCents: 0,
        currentBudgetCents: 0,
        scopeChanges: [],
        priceMovements: [],
      },
      history: { events: [] },
    },
  };
}

/**
 * The record's actor directory (person/org id → display name) for the Money and
 * History tabs' attribution. Both tabs are EMPTY in the S2 new-work shape, so an
 * empty map is correct and non-leaking today; it is built here (rather than
 * inlined in the page) so the place that will resolve v2 actor names when the
 * ledger read lands is already named. An unresolved id renders as "Unknown
 * party" via the page's `nameOf`, never an invented name (view.ts rule 2).
 *
 * The v2 record ledger keys `actor` by PERSON (doc 16), not the v1 `partyId`, so
 * this is deliberately NOT populated from the participant ORG list — a
 * participant org id is not an actor id, and mapping one onto the other would be
 * exactly the invented attribution rule 2 forbids. It resolves for real when the
 * History tab reads `AuditEntry.actor` from the v2 Record endpoint.
 */
export function emptyDirectory(): Directory {
  return new Map();
}
