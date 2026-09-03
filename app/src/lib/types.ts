// Contract types for the R0 API (docs/architecture/r0-technical-design.md §6).
// The frontend renders these shapes; it never computes budget/status itself
// (business-critical calc is server-side — role boundary). Pillars and the
// chain-verify result arrive pre-derived from the Ledger & Budget service.

export type Role = 'owner' | 'counterparty';
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
  members: Party[];
  pillars: Pillars;
  counts: {
    decisions: number;
    changeOrders: { total: number; proposed: number; approved: number; rejected: number };
  };
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
