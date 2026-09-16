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

export type OpenSections = Record<SectionKey, boolean>;

/**
 * Which sections open by default. Both can open — this is not a single choice.
 *
 * Execution — the plan itself, with its Gantt — is the surface a visitor comes to
 * /plan to read, so it opens by default in EVERY state (LINA-306: the founder
 * landed on /plan while Procurement was active and saw only the Procurement
 * "coming soon" placeholder, with the whole plan hidden behind a collapsed
 * Execution header). The plan is never the thing we hide.
 *
 * Procurement ADDITIONALLY opens while it is the genuinely active phase, so its
 * RFP loop is visible the moment it matters. Once a constructor is chosen
 * (procurement → archived, execution → active in one transaction) it collapses
 * to its badge as read-only history, and once execution is active or signed off
 * the plan stands alone.
 */
export function defaultOpenSections(
  procurementStatus: PhaseStatus | null,
  executionStatus: PhaseStatus | null,
): OpenSections {
  const executionLive = executionStatus === 'active' || executionStatus === 'signed_off';
  return {
    execution: true,
    procurement: procurementStatus === 'active' && !executionLive,
  };
}
