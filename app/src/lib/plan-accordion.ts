// The pure rules behind the `/plan` accordion shell (LINA-281, ADR-0023 §6).
//
// The shell stacks the two phases — Procurement and Execution — as collapsible
// sections on one page. Two questions are decided here rather than in JSX so
// they are total over their inputs and unit-tested: what each section's header
// badge says, and which section opens by default.
//
// The Execution badge is NOT computed here — it is the same word the sign-off
// panel shows, so the shell renders <PhaseBadge> from @/components/SignOffPanel
// and the two can never drift. This module owns only the Procurement badge and
// the default-open choice.

import type { WirePhase } from './api';

export type PhaseStatus = WirePhase['status'];

export interface BadgeSpec {
  label: string;
  /** Maps to the shared `.badge` tones in globals.css. */
  tone: 'ok' | 'warn' | 'neutral';
}

/**
 * The Procurement header badge. Procurement has no sign-off of its own, so its
 * states are simpler than Execution's:
 *   - active     → the RFP loop is open (or a legacy project's safe default).
 *   - pending    → skipped: the owner said they already have a contractor, so
 *                  procurement was never started (ADR-0023 §3, hasSignedContractor).
 *   - archived   → closed: a constructor was chosen, procurement is history.
 *   - signed_off → not a procurement state, but mapped defensively to "Closed".
 */
export function procurementBadge(status: PhaseStatus): BadgeSpec {
  switch (status) {
    case 'active': return { label: 'Active', tone: 'warn' };
    case 'pending': return { label: 'Skipped', tone: 'neutral' };
    case 'archived': return { label: 'Closed', tone: 'ok' };
    case 'signed_off': return { label: 'Closed', tone: 'ok' };
    default: return { label: String(status), tone: 'neutral' };
  }
}

export type SectionKey = 'procurement' | 'execution';

/**
 * Which section opens by default. The active phase is the one the party is
 * working in, so it opens; the other collapses to its badge. Only one phase is
 * active at a time by construction (selecting a constructor flips procurement
 * → archived and execution → active in one transaction), so this is a genuine
 * choice, not a guess.
 *
 * Execution wins the tie-breaks: a signed-off or awaiting-sign-off plan is the
 * live surface even though its DB status is not literally `active`, and if
 * neither phase is active (a fully closed-out build) the plan is still what a
 * visitor came to read. Procurement opens by default only while it is genuinely
 * the active phase.
 */
export function defaultOpenSection(
  procurementStatus: PhaseStatus | null,
  executionStatus: PhaseStatus | null,
): SectionKey {
  if (executionStatus === 'active' || executionStatus === 'signed_off') return 'execution';
  if (procurementStatus === 'active') return 'procurement';
  return 'execution';
}
