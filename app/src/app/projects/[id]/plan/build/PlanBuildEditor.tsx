'use client';

// The "Build the plan here" editor (LINA-228, ADR-0017).
//
// Pen: "S · (new) · Build the plan — schedule (Gantt)" / "Interaction spec —
// Create & organise tasks". The screen is copy + layout only — every edit is a
// pure operation from @/lib/plan-authoring (unit-tested under node --test), and
// the single write is authorPlan(). Two levels only: a phase holds tasks, a
// task holds nothing (contract §2).
//
// ── WHAT THE AUTHOR STARTS WITH ──────────────────────────────────────────────
// The standard skeleton (PLAN_SKELETON): three phases, names only — no dates, no
// owners, no sub-tasks. "That is for the user to fill" (the issue). The author
// renames, reorders, adds and removes, and dates what they know; blanks stay
// blank and normalise to null at the wire edge (toWire).
//
// ── WHAT CROSSES THE WIRE ─────────────────────────────────────────────────────
// Only `{ stages }`. The acting party is the session, resolved server-side — a
// client that could name itself could stamp authorship as someone else (§0).
// SAVING IS PRIVATE DRAFTING (LINA-230): the write lands as a DRAFT (one
// plan_drafted ledger event), NOT a proposal — the other party sees nothing and
// no approval is requested. Sending for approval is a separate, deliberate act on
// the plan page ("Send for approval"). On save we hand the returned audit id to
// /plan, which shows the "draft saved" stamp once and links to the audit trail.
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import {
  PlanAuthorError,
  addPhase, addTask, authorPlan, removePhase,
  removeTask, renamePhase, renameTask, reorderPhase, reorderTask,
  seedSkeleton, setTaskDate, taskCount, toWire,
  type PhaseDraft,
} from '@/lib/plan-authoring';
import '@/components/plan-build.css';

export function PlanBuildEditor({
  projectId, initialPhases,
}: {
  projectId: string;
  /** An existing saved draft to resume editing; absent → seed the skeleton. */
  initialPhases?: PhaseDraft[];
}) {
  const router = useRouter();
  const resuming = initialPhases != null && initialPhases.length > 0;

  // Resume an existing draft, else seed the standard skeleton. Both mint fresh
  // React keys, so this must run in a lazy initialiser, not on every render.
  const [phases, setPhases] = useState<PhaseDraft[]>(() => initialPhases ?? seedSkeleton());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Drag-to-reorder state. A phase drag and a task drag are mutually exclusive;
  // a task only drops within its own phase (`pi` guards the drop). Reordering is
  // a pure op (reorderPhase / reorderTask) — the same tested vocabulary as before,
  // just driven by a grab instead of step arrows (pen: "drag a row").
  const [dragPhase, setDragPhase] = useState<number | null>(null);
  const [dragTask, setDragTask] = useState<{ pi: number; ti: number } | null>(null);

  const count = useMemo(() => taskCount(phases), [phases]);

  // Every mutation goes through here so a fresh edit always clears a stale error.
  const apply = useCallback((next: PhaseDraft[]) => {
    setPhases(next);
    setError(null);
  }, []);

  const reset = useCallback(() => apply(seedSkeleton()), [apply]);

  const dropPhase = useCallback((to: number) => {
    setDragPhase((from) => {
      if (from !== null && from !== to) apply(reorderPhase(phases, from, to));
      return null;
    });
  }, [apply, phases]);

  const dropTask = useCallback((pi: number, to: number) => {
    setDragTask((d) => {
      if (d && d.pi === pi && d.ti !== to) apply(reorderTask(phases, pi, d.ti, to));
      return null;
    });
  }, [apply, phases]);

  const submit = useCallback(async () => {
    setError(null);
    let stages;
    try {
      stages = toWire(phases); // client-side validation → pointed message, no round-trip
    } catch (e) {
      setError(e instanceof PlanAuthorError ? e.message : 'Something is off with the plan.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await authorPlan(projectId, stages);
      // /plan reads the saved draft and shows the "draft saved" stamp once, then
      // links to the audit trail — the durable copy of what just happened. The
      // plan is NOT sent for approval here; that is a separate act on /plan.
      router.push(`/projects/${projectId}/plan?drafted=${encodeURIComponent(result.auditEventId)}`);
    } catch (e) {
      if (e instanceof PlanAuthorError && (e.code === 'open_plan_exists' || e.code === 'draft_exists')) {
        // A plan is already open/being drafted on this build — the write is not
        // this screen's to make. Send the author to the live plan rather than
        // leave them re-clicking a button that will keep 409-ing.
        router.push(`/projects/${projectId}/plan`);
        return;
      }
      setError(e instanceof PlanAuthorError ? e.message : 'That did not go through. Try again.');
      setSubmitting(false);
    }
  }, [phases, projectId, router]);

  return (
    <main className="pbx">
      <header className="pbx-head">
        <div>
          <p className="pbx-eyebrow">{resuming ? 'Your draft' : 'New plan'}</p>
          <h1 className="pbx-title">Build the plan directly in LinkNMS</h1>
          <p className="pbx-lede">
            Start from a standard skeleton, then rename, reorder, add and remove phases and tasks.
            Date what you know — leave the rest blank. Saving keeps this as your private draft —
            only you can see it, and nothing is sent until you choose to send it for approval.
          </p>
        </div>
        <span className="pbx-draft">Draft — only you can see it</span>
      </header>

      <div className="pbx-toolbar">
        <p className="pbx-count">
          {count} {count === 1 ? 'task' : 'tasks'} across {phases.length}{' '}
          {phases.length === 1 ? 'phase' : 'phases'}
        </p>
        <button type="button" className="pbx-icon" onClick={reset} disabled={submitting}
          title="Reset to the standard skeleton" style={{ width: 'auto', padding: '0 10px' }}>
          Reset to skeleton
        </button>
      </div>

      <ol className="pbx-phases">
        {phases.map((phase, pi) => (
          <li
            key={phase.key}
            className={`pbx-phase${dragPhase === pi ? ' is-dragging' : ''}`}
            onDragOver={(e) => { if (dragPhase !== null) e.preventDefault(); }}
            onDrop={(e) => { if (dragPhase !== null) { e.preventDefault(); dropPhase(pi); } }}
          >
            <div className="pbx-phase-hd">
              <span
                className="pbx-grip"
                role="button"
                tabIndex={-1}
                aria-label={`Drag to reorder phase ${pi + 1}`}
                title="Drag to reorder"
                draggable={!submitting}
                onDragStart={(e) => { setDragPhase(pi); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDragPhase(null)}
              >⠿</span>
              <span className="pbx-phase-n" aria-hidden>{pi + 1}</span>
              <input
                className="pbx-phase-name"
                value={phase.name}
                placeholder="Phase name"
                aria-label={`Phase ${pi + 1} name`}
                disabled={submitting}
                onChange={(e) => apply(renamePhase(phases, pi, e.target.value))}
              />
              <span className="pbx-rowctl">
                <button type="button" className="pbx-icon pbx-del" title="Remove phase"
                  disabled={submitting}
                  onClick={() => apply(removePhase(phases, pi))}>✕</button>
              </span>
            </div>

            <div className="pbx-tasks">
              {phase.tasks.length > 0 ? (
                <div className="pbx-taskhdr" aria-hidden>
                  <span /><span>Task</span><span>Start</span><span>End</span><span />
                </div>
              ) : null}
              {phase.tasks.map((task, ti) => {
                const dropTarget = dragTask?.pi === pi;
                return (
                <div
                  key={task.key}
                  className={`pbx-task${dragTask?.pi === pi && dragTask.ti === ti ? ' is-dragging' : ''}`}
                  onDragOver={(e) => { if (dropTarget) e.preventDefault(); }}
                  onDrop={(e) => { if (dropTarget) { e.preventDefault(); dropTask(pi, ti); } }}
                >
                  <span
                    className="pbx-grip"
                    role="button"
                    tabIndex={-1}
                    aria-label="Drag to reorder task"
                    title="Drag to reorder"
                    draggable={!submitting}
                    onDragStart={(e) => { setDragTask({ pi, ti }); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => setDragTask(null)}
                  >⠿</span>
                  <input
                    className="pbx-task-name"
                    value={task.name}
                    placeholder="Task name"
                    aria-label={`Task name`}
                    disabled={submitting}
                    onChange={(e) => apply(renameTask(phases, pi, ti, e.target.value))}
                  />
                  <input
                    type="date" className="pbx-date" value={task.start}
                    aria-label="Start date" disabled={submitting}
                    onChange={(e) => apply(setTaskDate(phases, pi, ti, 'start', e.target.value))}
                  />
                  <input
                    type="date" className="pbx-date" value={task.end}
                    aria-label="End date" disabled={submitting}
                    onChange={(e) => apply(setTaskDate(phases, pi, ti, 'end', e.target.value))}
                  />
                  <span className="pbx-rowctl">
                    <button type="button" className="pbx-icon pbx-del" title="Remove task"
                      disabled={submitting}
                      onClick={() => apply(removeTask(phases, pi, ti))}>✕</button>
                  </span>
                </div>
                );
              })}
              <button type="button" className="pbx-addtask" disabled={submitting}
                onClick={() => apply(addTask(phases, pi))}>+ Add task</button>
            </div>
          </li>
        ))}
      </ol>

      <button type="button" className="pbx-addtask" disabled={submitting}
        onClick={() => apply(addPhase(phases))} style={{ alignSelf: 'flex-start' }}>
        + Add phase
      </button>

      {error ? <p role="alert" className="pbx-open">{error}</p> : null}

      <div className="pbx-actions">
        <Link className="btn" href={`/projects/${projectId}/plan`}>Cancel</Link>
        <button type="button" className="btn primary" onClick={submit} disabled={submitting}>
          {submitting ? 'Saving…' : 'Save plan'}
        </button>
      </div>

      <p className="pbx-foot">
        Saving records your work as a private draft — only you can see it, and it records one event
        on the shared record that the draft was saved. It is not sent to the other party and no
        approval is requested until you choose <strong>Send for approval</strong> on the plan page.
      </p>
    </main>
  );
}
