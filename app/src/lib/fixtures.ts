// Demo data — the "Maple Street Renovation" scenario from the LINA-27 mockups.
// Used only when LINKNMS_API_BASE is unset (no backend wired yet). Every shape
// mirrors the §6 contract exactly, so swapping to live endpoints is a no-op for
// the UI. Owner Dana Okafor · GC Ridgeline Builders · baseline $240,000.

import type {
  Project,
  Decision,
  ChangeOrderDetail,
  ChangeOrderSummary,
  AuditResult,
} from './types';

export const DEMO_PROJECT_ID = 'maple-street';

const DANA = { id: 'p_dana', name: 'Dana Okafor', role: 'owner' as const };
const RIDGE = { id: 'p_ridge', name: 'Ridgeline Builders', role: 'counterparty' as const };

const BASELINE = 24_000_000; // $240,000 in cents
const CURRENT = 24_095_000; //  $240,950 — 2 approved changes

export const demoProject: Project = {
  id: DEMO_PROJECT_ID,
  name: 'Maple Street Renovation',
  baselineBudgetCents: BASELINE,
  currentBudgetCents: CURRENT,
  actingRole: 'owner',
  members: [DANA, RIDGE],
  pillars: {
    cost: {
      pillar: 'cost',
      status: 'green',
      label: 'On budget — $240,950.00',
      icon: 'check-circle',
      baselineCents: BASELINE,
      currentCents: CURRENT,
      deltaCents: CURRENT - BASELINE,
    },
    time: {
      pillar: 'time',
      status: 'green',
      label: 'No schedule changes recorded',
      icon: 'check-circle',
    },
    scope: {
      pillar: 'scope',
      status: 'amber',
      label: '1 open scope change',
      icon: 'alert-triangle',
    },
    quality: {
      pillar: 'quality',
      status: 'green',
      label: 'No quality concerns flagged',
      icon: 'check-circle',
    },
  },
  counts: {
    decisions: 3,
    changeOrders: { total: 3, proposed: 1, approved: 2, rejected: 0 },
  },
};

export const demoDecisions: Decision[] = [
  {
    id: 'd_windows',
    title: 'Confirm north elevation window sizes',
    body: 'North-facing windows confirmed at 1200×1500mm per revised elevation B. Supersedes the 1000×1400 shown on the original permit set.',
    authorName: DANA.name,
    authorRole: 'owner',
    createdAt: '2026-08-20T08:30:00Z',
    revisions: [
      {
        rev: 1,
        title: 'Confirm north elevation window sizes',
        body: 'North-facing windows confirmed at 1000×1400mm per original permit set.',
        authorName: DANA.name,
        authorRole: 'owner',
        createdAt: '2026-08-18T14:05:00Z',
      },
      {
        rev: 2,
        title: 'Confirm north elevation window sizes',
        body: 'North-facing windows confirmed at 1200×1500mm per revised elevation B. Supersedes the 1000×1400 shown on the original permit set.',
        authorName: DANA.name,
        authorRole: 'owner',
        createdAt: '2026-08-20T08:30:00Z',
      },
    ],
  },
  {
    id: 'd_slab',
    title: 'Foundation slab pour scheduled',
    body: 'Slab pour agreed for Aug 15 pending inspection sign-off. Ridgeline to confirm concrete supplier 48h prior.',
    authorName: RIDGE.name,
    authorRole: 'counterparty',
    createdAt: '2026-08-13T11:20:00Z',
    revisions: [
      {
        rev: 1,
        title: 'Foundation slab pour scheduled',
        body: 'Slab pour agreed for Aug 15 pending inspection sign-off. Ridgeline to confirm concrete supplier 48h prior.',
        authorName: RIDGE.name,
        authorRole: 'counterparty',
        createdAt: '2026-08-13T11:20:00Z',
      },
    ],
  },
  {
    id: 'd_kitchen',
    title: 'Kitchen layout locked (galley)',
    body: 'Galley layout locked; island dropped to preserve the walkway width Dana asked for. Appliance spec unchanged.',
    authorName: DANA.name,
    authorRole: 'owner',
    createdAt: '2026-08-12T16:45:00Z',
    revisions: [
      {
        rev: 1,
        title: 'Kitchen layout locked (galley)',
        body: 'Galley layout locked; island dropped to preserve the walkway width Dana asked for. Appliance spec unchanged.',
        authorName: DANA.name,
        authorRole: 'owner',
        createdAt: '2026-08-12T16:45:00Z',
      },
    ],
  },
];

export const demoChangeOrders: ChangeOrderDetail[] = [
  {
    id: 'co_oak',
    title: 'Engineered oak flooring (kitchen & hall)',
    status: 'proposed',
    costDeltaCents: 420_000, // +$4,200
    proposedByName: DANA.name,
    proposedByRole: 'owner',
    createdAt: '2026-08-25T09:10:00Z',
    budgetBeforeCents: CURRENT,
    budgetAfterCents: CURRENT + 420_000, // $245,150 if approved
    scopeImpactNote:
      'Owner selected engineered oak over the specified laminate in kitchen & hall (38 m²). Cost is the material + labour difference. Adds ~5 days to interior finishes.',
    scheduleImpactDays: 5,
    scheduleImpactNote: 'Adds ~5 days to interior finishes; sequenced after cabinetry.',
    qualityFlag: false,
  },
  {
    id: 'co_drainage',
    title: 'Additional perimeter drainage',
    status: 'approved',
    costDeltaCents: 68_000, // +$680
    proposedByName: RIDGE.name,
    proposedByRole: 'counterparty',
    createdAt: '2026-08-16T10:00:00Z',
    decidedByName: DANA.name,
    decidedByRole: 'owner',
    decidedAt: '2026-08-16T15:30:00Z',
    decision: 'approve',
    budgetBeforeCents: 24_027_000,
    budgetAfterCents: 24_095_000,
    scopeImpactNote: 'French drain added along the north retaining wall after site water was observed.',
    qualityFlag: false,
  },
  {
    id: 'co_panel',
    title: 'Upgrade electrical panel to 200A',
    status: 'approved',
    costDeltaCents: 27_000, // +$270
    proposedByName: RIDGE.name,
    proposedByRole: 'counterparty',
    createdAt: '2026-08-14T09:00:00Z',
    decidedByName: DANA.name,
    decidedByRole: 'owner',
    decidedAt: '2026-08-14T12:10:00Z',
    decision: 'approve',
    budgetBeforeCents: 24_000_000,
    budgetAfterCents: 24_027_000,
    scopeImpactNote: 'Panel upgraded from 100A to 200A to carry the added kitchen circuits.',
    qualityFlag: false,
  },
];

export const demoAudit: AuditResult = {
  verified: true,
  headHash: '9f2c…a71b',
  events: [
    {
      seq: 1,
      type: 'project_created',
      summary: 'Project “Maple Street Renovation” created',
      actorName: DANA.name,
      actorRole: 'owner',
      createdAt: '2026-08-12T09:00:00Z',
      entryHash: '0a11…c3d2',
    },
    {
      seq: 2,
      type: 'budget_baseline_set',
      summary: 'Baseline budget set to $240,000',
      actorName: DANA.name,
      actorRole: 'owner',
      createdAt: '2026-08-12T09:01:00Z',
      budgetDeltaCents: 0,
      entryHash: '1b22…d4e3',
    },
    {
      seq: 3,
      type: 'member_joined',
      summary: 'Ridgeline Builders joined as GC',
      actorName: RIDGE.name,
      actorRole: 'counterparty',
      createdAt: '2026-08-12T14:22:00Z',
      entryHash: '2c33…e5f4',
    },
    {
      seq: 4,
      type: 'decision_recorded',
      summary: 'Kitchen layout locked (galley)',
      actorName: DANA.name,
      actorRole: 'owner',
      createdAt: '2026-08-12T16:45:00Z',
      entryHash: '3d44…f605',
    },
    {
      seq: 5,
      type: 'change_order_approved',
      summary: 'Approved: Upgrade electrical panel to 200A (+$270)',
      actorName: DANA.name,
      actorRole: 'owner',
      createdAt: '2026-08-14T12:10:00Z',
      budgetDeltaCents: 27_000,
      entryHash: '4e55…0716',
    },
    {
      seq: 6,
      type: 'change_order_approved',
      summary: 'Approved: Additional perimeter drainage (+$680)',
      actorName: DANA.name,
      actorRole: 'owner',
      createdAt: '2026-08-16T15:30:00Z',
      budgetDeltaCents: 68_000,
      entryHash: '5f66…1827',
    },
    {
      seq: 7,
      type: 'decision_revised',
      summary: 'Revised (rev 2): Confirm north elevation window sizes',
      actorName: DANA.name,
      actorRole: 'owner',
      createdAt: '2026-08-20T08:30:00Z',
      entryHash: '6077…2938',
    },
    {
      seq: 8,
      type: 'change_order_proposed',
      summary: 'Proposed: Engineered oak flooring (kitchen & hall) (+$4,200)',
      actorName: DANA.name,
      actorRole: 'owner',
      createdAt: '2026-08-25T09:10:00Z',
      entryHash: '7188…3a49',
    },
  ],
};

export function summarize(co: ChangeOrderDetail): ChangeOrderSummary {
  const { id, title, status, costDeltaCents, proposedByName, proposedByRole, createdAt, decidedByName, decidedAt, scheduleImpactDays, qualityFlag } = co;
  return { id, title, status, costDeltaCents, proposedByName, proposedByRole, createdAt, decidedByName, decidedAt, scheduleImpactDays, qualityFlag };
}
