// Pure v2-wire → view transforms for the portfolio home (LINA-311, S1). Split
// out of `profile.ts` (which does the I/O and imports `server-only`) so the
// mapping is unit-testable without a Clerk session or a router — exactly as
// `lib/view.ts` is the pure counterpart to `lib/api.ts` on the v1 side.
//
// The mapping is product-critical: it is the last place a v2 org-centric record
// is translated into the v1-shaped `PortalUser`/`ProjectSummary` the pen screens
// render, and a wrong role or an invented budget delta here is a wrong answer to
// the record's only question. Every field is derived, never guessed.
import type { PortalUser } from '@/components/PortalShell';
import type { ProjectSummary, BuildStatus, Role, OperatingModel } from '@/lib/types';

// ── The v2 wire shapes we read (subset) ──────────────────────────────────────
// Verbatim against modules/identity + modules/project use-case bodies and
// cowork/documentation/api/v2/openapi.yaml.

export type V2OrgKind = 'household' | 'contractor' | 'consultant' | 'supplier';

export interface V2Money {
  amount_cents: number;
  currency: string;
}

export interface V2Person {
  id: string;
  email: string;
  name: string | null;
  phone?: string;
  locale: string;
}

export interface V2Org {
  id: string;
  kind: V2OrgKind;
  legal_name: string;
  nif?: string;
  approval_policy: string;
}

export interface V2Me {
  person: V2Person;
  active_org: V2Org | null;
  org_role: string | null;
  permissions: string[];
  organizations: { org: V2Org; org_role: string }[];
  pending_project_invitations: unknown[];
}

// project.project.status enum (modules/project/domain/lifecycle.mjs).
export type V2ProjectStatus =
  | 'draft' | 'tendering' | 'contracted' | 'in_execution' | 'closed' | 'cancelled';

export interface V2ProjectView {
  id: string;
  name: string;
  status: V2ProjectStatus;
  operating_model: 'undetermined' | OperatingModel;
  indicative_budget?: V2Money;
}

export interface V2Overview {
  project: V2ProjectView;
  open_variations: number;
  open_questions: number;
  pending_verifications: number;
}

export interface V2ProjectList {
  items: V2Overview[];
  next_cursor: string | null;
}

// ── Transforms ────────────────────────────────────────────────────────────────

// The account-menu role label is the party's NATURE across the record, which in
// v2 is the org kind (v1 read it off the per-party `role`; v2 has no such column,
// the org carries it). household is the owner side; contractor is the GC/trade
// side; the two professional kinds keep their own name rather than being folded
// into "GC", for the same reason roleLabel() refuses to (a wrong attribution is a
// wrong answer to the product's only question).
const ORG_ROLE_LABEL: Record<V2OrgKind, string> = {
  household: 'Owner',
  contractor: 'GC',
  consultant: 'Consultant',
  supplier: 'Supplier',
};

// The portfolio card's `role` (a v1 Role) drives a CSS tag + roleLabel(). The v2
// overview body carries no per-project participant role (that is an S2 dashboard
// read), so we approximate from the viewer's org kind: household → owner, every
// other kind → counterparty. Transitional and documented — under B2 the card
// rarely renders (the portfolio is empty), and S2 derives the real per-project
// role from the project's participant list.
export function cardRole(orgKind: V2OrgKind | null): Role {
  return orgKind === 'household' ? 'owner' : 'counterparty';
}

export function displayNameOf(person: V2Person): string {
  return person.name?.trim() || person.email?.split('@')[0] || 'Your account';
}

export function toPortalUser(me: V2Me): PortalUser {
  return {
    displayName: displayNameOf(me.person),
    roleLabel: me.active_org ? ORG_ROLE_LABEL[me.active_org.kind] : '',
  };
}

// v2 has a six-state lifecycle; the portfolio card only distinguishes "resumable
// draft" from "live", so everything past draft reads as active for the badge.
export function toBuildStatus(status: V2ProjectStatus): BuildStatus {
  return status === 'draft' ? 'draft' : 'active';
}

export function toProjectSummary(o: V2Overview, orgKind: V2OrgKind | null): ProjectSummary {
  const baseline = o.project.indicative_budget?.amount_cents ?? 0;
  return {
    id: o.project.id,
    name: o.project.name,
    status: toBuildStatus(o.project.status),
    role: cardRole(orgKind),
    operatingModel: o.project.operating_model === 'undetermined' ? null : o.project.operating_model,
    baselineBudgetCents: baseline,
    // No movement roll-up on the overview body (that is a contracting read,
    // phases 4-5 / S2). A fresh v2 project has moved nothing, so current ==
    // baseline is the honest figure, never an invented delta.
    currentBudgetCents: baseline,
    // Members and the CO/decision counts are not on the overview projection; the
    // card renders neither the member list nor a non-zero count for a build with
    // no recorded activity. Honest empties, resolved for real by S2.
    members: [],
    counts: { changeOrders: 0, decisions: 0 },
    updatedAt: '',
  };
}
