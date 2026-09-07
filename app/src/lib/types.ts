// Contract types for the R0 API (docs/architecture/r0-technical-design.md §6).
// The frontend renders these shapes; it never computes budget/status itself
// (business-critical calc is server-side — role boundary). Pillars and the
// chain-verify result arrive pre-derived from the Ledger & Budget service.

// `subcontractor` arrived with migration 0009 / ADR-0011 decision 4: the launch
// role vocabulary. The GC deliberately STAYS `counterparty` (no rename), so every
// existing surface keeps rendering unchanged; specialty subs are the new value.
export type Role = 'owner' | 'counterparty' | 'subcontractor';

// Band B (ADR-0011 decision 1). Chosen once during build creation and never asked
// again — it decides which counterparty role the build may invite.
export type OperatingModel = 'turnkey' | 'direct' | 'hybrid';

// ADR-0011 decision 2, draft-first: the build row exists from wizard step 1 and
// flips to `active` when the first invite commits it. A `null` operatingModel is
// a first-class "not chosen yet" — a draft mid-wizard, or a pre-Band-B project.
export type BuildStatus = 'draft' | 'active';

export type RagStatus = 'green' | 'amber' | 'red';
export type IconName = 'check-circle' | 'info' | 'alert-triangle' | 'alert-octagon';
export type PillarKey = 'cost' | 'time' | 'scope' | 'quality';
export type CoStatus = 'proposed' | 'approved' | 'rejected';

export interface Party {
  id: string;
  name: string;
  role: Role;
}

// GET /me response shape — the authenticated party's own profile.
// displayName is the authoritative name from identity.party (LINA-132 setup),
// never derived from the email local-part.
export interface MeProfile {
  partyId: string;
  displayName: string;
  email: string | null;
  role: string;
}

// GET /invitations/:token — the unauthenticated preview behind the Band B
// accept deep link (LINA-182). Returned to a signed-out visitor who holds only
// the token; unknown and spent tokens are an indistinguishable 404.
export interface InvitationPreview {
  projectName: string | null;
  invitedByName: string | null;
  role: Role;
  email: string | null;
  status: 'pending';
}

export interface Pillar {
  pillar: PillarKey;
  status: RagStatus;
  label: string;
  icon: IconName;
  // cost pillar only:
  baselineCents?: number;
  currentCents?: number;
  deltaCents?: number;
}

export interface Pillars {
  cost: Pillar;
  time: Pillar;
  scope: Pillar;
  quality: Pillar;
}

export interface Project {
  id: string;
  name: string;
  baselineBudgetCents: number;
  currentBudgetCents: number;
  actingRole: Role; // the party derived server-side from the session
  // Band B projections (ADR-0011). Optional so the R0 surfaces that predate the
  // wizard keep compiling against a project fetched before 0009 back-filled.
  status?: BuildStatus;
  operatingModel?: OperatingModel | null;
  members: Party[];
  pillars: Pillars;
  counts: {
    decisions: number;
    changeOrders: { total: number; proposed: number; approved: number; rejected: number };
  };
}

// GET /projects (ADR-0012 §A1) — the portfolio card. A projection of the full
// Project: per-card counts are the cheap server-batched folds, and member names
// are resolved server-side so the home screen needs no directory mapping.
export interface ProjectCardMember {
  role: Role;
  name: string | null; // null only when the store has no display name yet
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: BuildStatus;
  role: Role; // the ACTING party's role, derived server-side
  operatingModel: OperatingModel | null;
  baselineBudgetCents: number;
  currentBudgetCents: number; // baseline + Σ approved change orders (ledger)
  members: ProjectCardMember[];
  counts: { changeOrders: number; decisions: number };
  updatedAt: string; // ISO-8601 — most recent record activity (ledger head)
}

export interface Revision {
  rev: number;
  title: string;
  body: string;
  authorName: string;
  authorRole: Role;
  createdAt: string; // ISO
}

export interface Decision {
  id: string;
  title: string;
  body: string;
  authorName: string;
  authorRole: Role;
  createdAt: string;
  revisions: Revision[]; // includes rev 1; length > 1 ⇒ "edited"
}

export interface ChangeOrderSummary {
  id: string;
  title: string;
  status: CoStatus;
  costDeltaCents: number;
  proposedByName: string;
  proposedByRole: Role;
  createdAt: string;
  decidedByName?: string;
  decidedAt?: string;
  scheduleImpactDays?: number;
  qualityFlag?: boolean;
}

export interface ChangeOrderDetail extends ChangeOrderSummary {
  decisionId?: string;
  decidedByRole?: Role;
  decision?: 'approve' | 'reject';
  budgetBeforeCents: number;
  budgetAfterCents: number; // if approved: after the move; else the hypothetical
  scopeImpactNote?: string;
  scheduleImpactNote?: string;
  qualityNote?: string;
}

export type AuditEventType =
  | 'project_created'
  | 'budget_baseline_set'
  | 'member_joined'
  | 'decision_recorded'
  | 'decision_revised'
  | 'change_order_proposed'
  | 'change_order_approved'
  | 'change_order_rejected';

export interface AuditEvent {
  seq: number;
  type: AuditEventType;
  summary: string;
  actorName: string;
  actorRole: Role;
  createdAt: string;
  budgetDeltaCents?: number;
  entryHash: string;
}

export interface AuditResult {
  events: AuditEvent[];
  // true when the chain verifies; otherwise the first broken seq (design §6).
  verified: true | number;
  headHash: string;
}
