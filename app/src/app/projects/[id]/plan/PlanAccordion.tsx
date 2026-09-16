'use client';

// The `/plan` accordion shell (LINA-281, ADR-0023 §6). One page, two stacked
// phase sections — Procurement and Execution — each a collapsible section with a
// header (phase name + status badge) and a body. The active phase opens by
// default; the others collapse to their badge and stay expandable for read-only
// history. Open/close is local UI state and touches no URL: a per-phase route
// would go stale the moment a phase transitioned (ADR-0023 §4).
//
// ── WHAT THIS FILE OWNS, AND WHAT IT DOES NOT ────────────────────────────────
// It owns the accordion chrome and nothing else. The section *bodies* are handed
// in as slots by the server page — the plan surface, the sign-off panel, the
// procurement tools — because each of those needs server-fetched data this shell
// has no business re-reading. The Execution badge is rendered from the same
// <PhaseBadge> the sign-off panel uses, so the header word and the panel word
// can never drift; the Procurement badge is the pure `procurementBadge` rule.

import { useState, type ReactNode } from 'react';

import type { WirePhase } from '@/lib/api';
import { procurementBadge, defaultOpenSections, type SectionKey } from '@/lib/plan-accordion';
import { PhaseBadge } from '@/components/SignOffPanel';
import '@/components/plan-accordion.css';

export interface PlanAccordionProps {
  /** The procurement phase's status, or null if the project has no procurement phase. */
  procurementStatus: WirePhase['status'] | null;
  /** The execution phase, passed straight to <PhaseBadge> and used to pick the default-open section. */
  executionPhase: WirePhase | null;
  /** The Procurement section body — the RFP composer + proposals inbox (or a placeholder until its BE lands). */
  procurementSlot: ReactNode;
  /** The Execution section body — the plan surface + sign-off controls, or an inline authoring editor. */
  executionSlot: ReactNode;
  /**
   * Force a section open regardless of phase status. Set to 'execution' when the
   * page is in an authoring mode (`?compose=build|import`), so the editor the
   * visitor asked for is never hidden behind a collapsed header.
   */
  forceOpen?: SectionKey | null;
}

export function PlanAccordion({
  procurementStatus, executionPhase, procurementSlot, executionSlot, forceOpen = null,
}: PlanAccordionProps) {
  // In an authoring mode (`?compose=build|import`) we force just that section
  // open so the editor the visitor asked for is never hidden. Otherwise both
  // sections decide independently: Execution (the plan + Gantt) always opens, and
  // Procurement opens too while it is the active phase (LINA-281 / LINA-306).
  const initialOpen: Record<SectionKey, boolean> = forceOpen
    ? { procurement: forceOpen === 'procurement', execution: forceOpen === 'execution' }
    : defaultOpenSections(procurementStatus, executionPhase?.status ?? null);

  // Each section toggles independently — collapsing an open phase to read a
  // closed one, or opening both, is the reader's call.
  const [open, setOpen] = useState<Record<SectionKey, boolean>>(initialOpen);

  const toggle = (key: SectionKey) => setOpen((o) => ({ ...o, [key]: !o[key] }));

  const prcBadge = procurementStatus ? procurementBadge(procurementStatus) : null;

  return (
    <div className="plac">
      {/* ── Procurement ─────────────────────────────────────────────────── */}
      <section className="plac-sec">
        <h2 className="plac-hd">
          <button
            type="button"
            className="plac-toggle"
            aria-expanded={open.procurement}
            aria-controls="plac-procurement"
            onClick={() => toggle('procurement')}
          >
            <span className={`plac-caret${open.procurement ? ' is-open' : ''}`} aria-hidden="true">▸</span>
            <span className="plac-name">Procurement</span>
            {prcBadge ? <span className={`badge ${prcBadge.tone} plac-badge`}>{prcBadge.label}</span> : null}
          </button>
        </h2>
        {open.procurement ? (
          <div className="plac-body" id="plac-procurement" role="region" aria-label="Procurement phase">
            {procurementSlot}
          </div>
        ) : null}
      </section>

      {/* ── Execution ───────────────────────────────────────────────────── */}
      <section className="plac-sec">
        <h2 className="plac-hd">
          <button
            type="button"
            className="plac-toggle"
            aria-expanded={open.execution}
            aria-controls="plac-execution"
            onClick={() => toggle('execution')}
          >
            <span className={`plac-caret${open.execution ? ' is-open' : ''}`} aria-hidden="true">▸</span>
            <span className="plac-name">Execution</span>
            <span className="plac-badge">
              <PhaseBadge phase={executionPhase} />
            </span>
          </button>
        </h2>
        {open.execution ? (
          <div className="plac-body" id="plac-execution" role="region" aria-label="Execution phase">
            {executionSlot}
          </div>
        ) : null}
      </section>
    </div>
  );
}
