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
// Since LINA-233 the tree also carries its predecessor graph: each node's local
// `key` plus the keys it `dependsOn`. THE WHOLE GRAPH GOES ON EVERY SAVE — the
// server rebuilds a draft's links atomically inside the same transaction as the
// stages, so there is no second endpoint and no partial edit to reconcile.
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
  addPhase, addTask, authorPlan, dependencyChoices, dependsOnOf, detectCycle, nodeIndex, removePhase,
  removeTask, renamePhase, renameTask, reorderPhase, reorderTask,
  seedSkeleton, setTaskDate, setTaskDates, setTaskDescription, taskCount, toggleDependency, toWire,
  type PhaseDraft, type PlanNodeRef,
} from '@/lib/plan-authoring';
import { PlanGantt } from './PlanGantt';
import '@/components/plan-build.css';

// ── "Depends on" (LINA-233, ADR-0017 annex 2) ───────────────────────────────
// One control, used on a phase header and on a task row alike — any stage may
// depend on any other, so there is no reason for two. It is a button plus, when
// there is something to show, a sub-row of predecessor chips; the picker itself
// is a popover of checkboxes grouped by phase, each option printed as the pen
// prints it ("1.2 Framing"). No link-lines: the Gantt drawing rides the deferred
// §5 drag item, and a v1 that chips honestly beats one that draws half a Gantt.
function DependsOn({
  nodeKey, label, phases, index, open, disabled, onOpen, onToggle,
}: {
  nodeKey: string;
  label: string;
  phases: PhaseDraft[];
  index: Map<string, PlanNodeRef>;
  open: boolean;
  disabled: boolean;
  onOpen: (next: boolean) => void;
  onToggle: (dep: string) => void;
}) {
  const deps = dependsOnOf(phases, nodeKey);
  const groups = useMemo(
    () => (open ? dependencyChoices(phases, nodeKey) : []),
    [open, phases, nodeKey],
  );
  const selected = new Set(deps);

  return (
    <div className="pbx-deps">
      <button
        type="button"
        className={`pbx-depbtn${deps.length ? ' has-deps' : ''}`}
        aria-expanded={open}
        aria-label={`Depends on — choose what “${label}” must follow`}
        title="Depends on"
        disabled={disabled}
        onClick={() => onOpen(!open)}
      >
        ⇠ Depends on{deps.length ? ` · ${deps.length}` : ''}
      </button>

      {deps.map((k) => {
        const n = index.get(k);
        if (!n) return null;
        return (
          <span key={k} className="pbx-dep-chip">
            {n.label}
            <button
              type="button"
              className="pbx-dep-x"
              aria-label={`Remove dependency on ${n.label}`}
              disabled={disabled}
              onClick={() => onToggle(k)}
            >✕</button>
          </span>
        );
      })}

      {open ? (
        <>
          {/* Click-away. A plain overlay rather than a document listener: it
              cannot leak past unmount, and Escape still closes from the panel. */}
          <div className="pbx-dep-away" role="presentation" onClick={() => onOpen(false)} />
          <div
            className="pbx-dep-pop"
            role="group"
            aria-label={`What ${label} depends on`}
            onKeyDown={(e) => { if (e.key === 'Escape') onOpen(false); }}
          >
            <p className="pbx-dep-hint">
              Pick the stages that must finish first. Anything that would loop back on this
              one is left out.
            </p>
            {groups.length === 0 ? (
              <p className="pbx-dep-empty">Nothing else in this plan to depend on yet.</p>
            ) : groups.map((g) => (
              <div key={g.phase.key} className="pbx-dep-group">
                <p className="pbx-dep-grouphd">{g.phase.label}</p>
                {g.options.map((o) => (
                  <label key={o.key} className="pbx-dep-opt">
                    <input
                      type="checkbox"
                      checked={selected.has(o.key)}
                      disabled={disabled}
                      onChange={() => onToggle(o.key)}
                    />
                    <span>{o.label}{o.isPhase ? <em className="pbx-dep-whole"> · whole phase</em> : null}</span>
                  </label>
                ))}
              </div>
            ))}
            <div className="pbx-dep-foot">
              <button type="button" className="pbx-icon" style={{ width: 'auto', padding: '0 10px' }}
                onClick={() => onOpen(false)}>Done</button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

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

  // The task-detail drawer (LINA-234). Holds the {phase, task} index of the open
  // task, or null when closed. The drawer edits that task's description; status is
  // read-only here — a draft has no reported progress, so it is always "Not
  // started" until the plan is live (ADR-0019).
  const [openTask, setOpenTask] = useState<{ pi: number; ti: number } | null>(null);
  const active = openTask ? phases[openTask.pi]?.tasks[openTask.ti] ?? null : null;

  // Drag-to-reorder state. A phase drag and a task drag are mutually exclusive;
  // a task only drops within its own phase (`pi` guards the drop). Reordering is
  // a pure op (reorderPhase / reorderTask) — the same tested vocabulary as before,
  // just driven by a grab instead of step arrows (pen: "drag a row").
  const [dragPhase, setDragPhase] = useState<number | null>(null);
  const [dragTask, setDragTask] = useState<{ pi: number; ti: number } | null>(null);

  // "Depends on" (LINA-233). `openDeps` is the key of the row whose picker is
  // open — one at a time, so the popovers can't stack. `serverCycle` holds the
  // stages the SERVER named on a 409: it is the authority on the graph, and its
  // answer outlives our own check, so the offending rows stay lit until edited.
  const [openDeps, setOpenDeps] = useState<string | null>(null);
  const [serverCycle, setServerCycle] = useState<Array<{ key: string | null; name: string }>>([]);

  // Which face of the same draft the author is looking at: the editable LIST or
  // the drag-to-schedule TIMELINE (LINA-236). Both drive the same `phases` state
  // through the same ops — the toggle changes the affordance, not the data.
  const [view, setView] = useState<'list' | 'timeline'>('list');

  const count = useMemo(() => taskCount(phases), [phases]);
  const index = useMemo(() => nodeIndex(phases), [phases]);

  // The picker already refuses a choice that would loop, so this should never
  // fire — it is the belt to that braces: "Save plan" stays disabled while a
  // cycle exists (contract §4) rather than firing a request certain to 409.
  const cycle = useMemo(() => detectCycle(phases), [phases]);
  const litRows = useMemo(() => new Set<string>([
    ...(cycle ?? []).map((n) => n.key),
    ...serverCycle.map((s) => s.key).filter((k): k is string => typeof k === 'string'),
  ]), [cycle, serverCycle]);

  // Every mutation goes through here so a fresh edit always clears a stale error.
  const apply = useCallback((next: PhaseDraft[]) => {
    setPhases(next);
    setError(null);
    setServerCycle([]);
  }, []);

  const toggleDep = useCallback((nodeKey: string, dep: string) => {
    apply(toggleDependency(phases, nodeKey, dep));
  }, [apply, phases]);

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

  // A Gantt drag lands here: write the task's new start/finish in one op. Same
  // draft, same tested vocabulary the list uses — the timeline just computes the
  // dates from a pointer instead of a date picker (LINA-236).
  const setDates = useCallback((pi: number, ti: number, start: string, end: string) => {
    apply(setTaskDates(phases, pi, ti, start, end));
  }, [apply, phases]);

  const submit = useCallback(async () => {
    setError(null);
    setServerCycle([]);
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
      // THE SERVER IS THE AUTHORITY ON THE GRAPH (contract §3). It revalidates
      // the whole thing on every save and names the offending stages, so a
      // refusal is surfaced as ITS answer — the chain lights up on the rows and
      // is spelled out in the alert, rather than being restated in our words.
      if (e instanceof PlanAuthorError && e.code === 'dependency_cycle') {
        const stagesOnCycle = e.details?.stages ?? [];
        setServerCycle(stagesOnCycle);
        setError(stagesOnCycle.length
          ? `These stages depend on each other in a loop: ${stagesOnCycle.map((s) => s.name).join(' → ')} → ${stagesOnCycle[0].name}. Remove one of the links to save.`
          : e.message);
        setSubmitting(false);
        return;
      }
      if (e instanceof PlanAuthorError && e.code === 'unknown_dependency') {
        setError(`“${e.details?.stage ?? 'A stage'}” depends on something that is no longer in this plan. Remove that link and save again.`);
        setSubmitting(false);
        return;
      }
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
        <div className="pbx-toolbar-r">
          <div className="pbx-viewtog" role="tablist" aria-label="Plan view">
            <button
              type="button" role="tab" aria-selected={view === 'list'}
              className={`pbx-viewtab${view === 'list' ? ' is-on' : ''}`}
              onClick={() => setView('list')}
            >List</button>
            <button
              type="button" role="tab" aria-selected={view === 'timeline'}
              className={`pbx-viewtab${view === 'timeline' ? ' is-on' : ''}`}
              onClick={() => setView('timeline')}
            >Timeline</button>
          </div>
          <button type="button" className="pbx-icon" onClick={reset} disabled={submitting}
            title="Reset to the standard skeleton" style={{ width: 'auto', padding: '0 10px' }}>
            Reset to skeleton
          </button>
        </div>
      </div>

      {view === 'timeline' ? (
        <PlanGantt
          phases={phases}
          disabled={submitting}
          onDates={setDates}
          onOpenTask={(pi, ti) => setOpenTask({ pi, ti })}
        />
      ) : (
      <>
      <ol className="pbx-phases">
        {phases.map((phase, pi) => (
          <li
            key={phase.key}
            className={`pbx-phase${dragPhase === pi ? ' is-dragging' : ''}${litRows.has(phase.key) ? ' is-cycle' : ''}`}
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

            {/* A phase is a stage like any other — it may follow another phase,
                or a single task in one (scope = any-stage, ADR-0017 annex 2). */}
            <DependsOn
              nodeKey={phase.key}
              label={index.get(phase.key)?.label ?? `Phase ${pi + 1}`}
              phases={phases}
              index={index}
              open={openDeps === phase.key}
              disabled={submitting}
              onOpen={(next) => setOpenDeps(next ? phase.key : null)}
              onToggle={(dep) => toggleDep(phase.key, dep)}
            />

            <div className="pbx-tasks">
              {phase.tasks.length > 0 ? (
                <div className="pbx-taskhdr" aria-hidden>
                  <span /><span>Task</span><span>Start</span><span>End</span><span />
                </div>
              ) : null}
              {phase.tasks.map((task, ti) => {
                const dropTarget = dragTask?.pi === pi;
                return (
                <div key={task.key} className={`pbx-taskwrap${litRows.has(task.key) ? ' is-cycle' : ''}`}>
                <div
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
                    <button
                      type="button"
                      className={`pbx-icon pbx-details${task.description.trim() ? ' has-note' : ''}`}
                      title="Task details"
                      aria-label={`Open details for ${task.name.trim() || 'this task'}`}
                      disabled={submitting}
                      onClick={() => setOpenTask({ pi, ti })}
                    >
                      ⋯{task.description.trim() ? <span className="pbx-dot" aria-hidden /> : null}
                    </button>
                    <button type="button" className="pbx-icon pbx-del" title="Remove task"
                      disabled={submitting}
                      onClick={() => apply(removeTask(phases, pi, ti))}>✕</button>
                  </span>
                </div>
                <DependsOn
                  nodeKey={task.key}
                  label={index.get(task.key)?.label ?? 'this task'}
                  phases={phases}
                  index={index}
                  open={openDeps === task.key}
                  disabled={submitting}
                  onOpen={(next) => setOpenDeps(next ? task.key : null)}
                  onToggle={(dep) => toggleDep(task.key, dep)}
                />
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
      </>
      )}

      {cycle ? (
        <p role="alert" className="pbx-cycle">
          <strong>These stages wait on each other in a loop:</strong>{' '}
          {cycle.map((n) => n.label).join(' → ')} → {cycle[0].label}. Remove one of the links to save.
        </p>
      ) : null}

      {error ? <p role="alert" className="pbx-open">{error}</p> : null}

      <div className="pbx-actions">
        <Link className="btn" href={`/projects/${projectId}/plan`}>Cancel</Link>
        <button type="button" className="btn primary" onClick={submit} disabled={submitting || cycle !== null}>
          {submitting ? 'Saving…' : 'Save plan'}
        </button>
      </div>

      <p className="pbx-foot">
        Saving records your work as a private draft — only you can see it, and it records one event
        on the shared record that the draft was saved. It is not sent to the other party and no
        approval is requested until you choose <strong>Send for approval</strong> on the plan page.
      </p>

      {openTask && active ? (
        <div
          className="pbx-drawer-scrim"
          role="presentation"
          onClick={() => setOpenTask(null)}
        >
          <aside
            className="pbx-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Task details"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="pbx-drawer-hd">
              <div>
                <p className="pbx-drawer-eyebrow">Task details</p>
                <h2 className="pbx-drawer-title">{active.name.trim() || 'Untitled task'}</h2>
              </div>
              <button
                type="button"
                className="pbx-icon"
                title="Close"
                aria-label="Close task details"
                onClick={() => setOpenTask(null)}
              >✕</button>
            </header>

            {/* Status is DERIVED from reported progress, never authored (ADR-0019).
                A draft has no progress, so it reads "Not started" until the plan is
                live — shown read-only so nothing here can desync from the record. */}
            <div className="pbx-drawer-status">
              <span className="pbx-status-chip">Not started</span>
              <span className="pbx-status-hint">
                Progress is reported once the plan is live and agreed — you can’t set it while drafting.
              </span>
            </div>

            <label className="pbx-drawer-label" htmlFor="pbx-task-desc">Description</label>
            <textarea
              id="pbx-task-desc"
              className="pbx-drawer-desc"
              value={active.description}
              placeholder="What is this task? Add scope, context, anything the other party should know."
              maxLength={4000}
              disabled={submitting}
              onChange={(e) => apply(setTaskDescription(phases, openTask.pi, openTask.ti, e.target.value))}
            />

            <div className="pbx-drawer-actions">
              <button type="button" className="btn primary" onClick={() => setOpenTask(null)}>Done</button>
            </div>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
