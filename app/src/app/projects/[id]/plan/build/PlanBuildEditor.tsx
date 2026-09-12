'use client';

// The "Build the plan here" editor (LINA-228, ADR-0017).
//
// Pen: "S · (new) · Build the plan — schedule (Gantt)" / "Interaction spec —
// Create & organise tasks". The screen is copy + layout only — every edit is a
// pure operation from @/lib/plan-authoring (unit-tested under node --test), and
// the single write is authorPlan(). Three levels, never four (LINA-243,
// ADR-0019): a phase holds tasks, a task holds sub-tasks, a sub-task holds
// nothing. The screen refuses the fourth level by never drawing an "add" for it.
//
// SINCE LINA-248 THERE IS ONE VIEW, NOT TWO. The old List/Timeline toggle is
// gone: the plan is a single grid (PlanGrid) — an editable table on the left
// (id · name · specialty · owner · start · finish) with the Gantt canvas always
// visible beside it, row-aligned. Clicking a row opens the detail drawer here;
// renaming is the row's ✎ button; an undated row is scheduled by clicking its
// empty track (a one-week bar lands on the clicked day, then drags).
//
// ── WHAT THE AUTHOR STARTS WITH ──────────────────────────────────────────────
// Their own default scaffold: the page resolves GET /me/plan-template server-side
// (their saved default → the system one) and passes its names-only body as
// `templateBody` (LINA-242, ADR-0018). PLAN_SKELETON is now only the fallback for
// when that read failed. Either way it is names only — no dates, no owners, no
// sub-tasks. "That is for the user to fill" (the issue). The author renames,
// reorders, adds and removes, and dates what they know; blanks stay blank and
// normalise to null at the wire edge (toWire).
//
// "Save as my default" sends the CURRENT structure back as a template — names
// only, dates and descriptions dropped (toTemplateBody), because those are this
// project's answers, not the shape. It is a private preference, NOT the plan
// write: no stage, version or ledger event is touched and nothing is sent for
// approval. Templates copy, never link (ADR-0018).
//
// ── WHAT CROSSES THE WIRE ─────────────────────────────────────────────────────
// Only `{ stages }`. The acting party is the session, resolved server-side — a
// client that could name itself could stamp authorship as someone else (§0).
// Since LINA-233 the tree also carries its predecessor graph: each node's local
// `key` plus the TYPED links it `dependsOn` — `{ key, type }`, where the type is
// Starts after / Starts with / Ends with (ADR-0020, contract v5; the generic
// "depends on" is gone). THE WHOLE GRAPH GOES ON EVERY SAVE — the
// server rebuilds a draft's links atomically inside the same transaction as the
// stages, so there is no second endpoint and no partial edit to reconcile.
// SAVING IS PRIVATE DRAFTING (LINA-230): the write lands as a DRAFT (one
// plan_drafted ledger event), NOT a proposal — the other party sees nothing and
// no approval is requested. Sending for approval is a separate, deliberate act on
// the plan page ("Send for approval"). On save we hand the returned audit id to
// /plan, which shows the "draft saved" stamp once and links to the audit trail.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import {
  DEP_HINTS, DEP_LABELS, DEP_TYPES, PlanAuthorError,
  addPhase, addSubtask, addTask, authorPlan, demoteNode, dependencyChoices, dependsOnOf, detectCycle, nodeIndex,
  promoteNode,
  removePhase, removeSubtask, removeTask, renamePhase, renameSubtask, renameTask,
  reorderPhase, reorderSubtask, reorderTask,
  saveMyDefaultTemplate, seedFromTemplate, seedSkeleton,
  setAssignee, setDependencyType, setSubtaskDate, setSubtaskDates, setSubtaskDescription,
  setTaskDate, setTaskDates, setTaskDescription, setTrade,
  subtaskCount, taskCount, toggleDependency, toTemplateBody, toWire,
  type DepType, type PhaseDraft, type PlanNodeRef, type TemplatePhase,
} from '@/lib/plan-authoring';
import { PartyAvatar, UnassignedAvatar } from '@/components/PartyAvatar';
import { partyIndex, partyOf, roleWord, type PartyRef } from '@/lib/party-display';
import { TaskWorkspace } from '@/components/TaskWorkspace';
import { taskPath } from '@/lib/task-workspace';
import { PlanGrid } from './PlanGrid';
import '@/components/plan-build.css';

// ── "Scheduling links" (LINA-233; typed by ADR-0020 / LINA-253) ─────────────
// One control for phases, tasks and sub-tasks alike — any stage may be linked to
// any other. Since LINA-248 it lives in the detail drawer (the founder's rows
// carry who/what/when; the graph is drawer detail).
//
// THE GENERIC "DEPENDS ON" IS GONE. A link no longer just says THAT one stage
// waits on another — it says HOW: Starts after / Starts with / Ends with. So the
// control is two gestures, deliberately separate:
//   1. the POPOVER picks WHICH stages this one is linked to (checkboxes grouped
//      by phase, exactly as before — a new link is born "Starts after");
//   2. each linked chip then carries its own type <select>, so changing what a
//      link MEANS never risks unpicking it.
// That split is why re-ticking a checked stage still removes the link outright:
// the picker is membership, the chip is meaning, and neither does the other's
// job by accident.
function SchedulingLinks({
  nodeKey, label, phases, index, open, disabled, onOpen, onToggle, onRetype,
}: {
  nodeKey: string;
  label: string;
  phases: PhaseDraft[];
  index: Map<string, PlanNodeRef>;
  open: boolean;
  disabled: boolean;
  onOpen: (next: boolean) => void;
  onToggle: (dep: string) => void;
  onRetype: (dep: string, type: DepType) => void;
}) {
  const deps = dependsOnOf(phases, nodeKey);
  const groups = useMemo(
    () => (open ? dependencyChoices(phases, nodeKey) : []),
    [open, phases, nodeKey],
  );
  const selected = new Set(deps.map((d) => d.on));

  return (
    <div className="pbx-deps">
      <button
        type="button"
        className={`pbx-depbtn${deps.length ? ' has-deps' : ''}`}
        aria-expanded={open}
        aria-label={`Scheduling links — choose what “${label}” is scheduled against`}
        title="Link this stage to another one’s dates"
        disabled={disabled}
        onClick={() => onOpen(!open)}
      >
        ⇠ Link to a stage{deps.length ? ` · ${deps.length}` : ''}
      </button>

      {deps.map((d) => {
        const n = index.get(d.on);
        if (!n) return null;
        return (
          <span key={d.on} className="pbx-dep-chip">
            {/* The type sits FIRST, so the chip reads as a sentence:
                "Starts after · 1.2 Design & Engineering". */}
            <select
              className="pbx-dep-type"
              value={d.type}
              aria-label={`How “${label}” is scheduled against ${n.label}`}
              title={`This stage ${DEP_HINTS[d.type]}`}
              disabled={disabled}
              onChange={(e) => onRetype(d.on, e.target.value as DepType)}
            >
              {DEP_TYPES.map((t) => (
                <option key={t} value={t}>{DEP_LABELS[t]}</option>
              ))}
            </select>
            <span className="pbx-dep-name">{n.label}</span>
            <button
              type="button"
              className="pbx-dep-x"
              aria-label={`Remove the scheduling link to ${n.label}`}
              disabled={disabled}
              onClick={() => onToggle(d.on)}
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
            aria-label={`What ${label} is scheduled against`}
            onKeyDown={(e) => { if (e.key === 'Escape') onOpen(false); }}
          >
            <p className="pbx-dep-hint">
              Pick the stages this one is scheduled against — you say how each link works on
              the chip afterwards. Anything that would loop back on this one is left out.
            </p>
            {groups.length === 0 ? (
              <p className="pbx-dep-empty">Nothing else in this plan to link to yet.</p>
            ) : groups.map((g) => (
              <div key={g.phase.key} className="pbx-dep-group">
                <p className="pbx-dep-grouphd">{g.phase.label}</p>
                {g.options.map((o) => (
                  <label key={o.key} className={`pbx-dep-opt lvl-${o.level}`}>
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

/**
 * Where a stage key sits in the draft — the permalink's `{pi, ti, si}`.
 *
 * Null when the key names nothing here: the permalink page has already refused
 * an unknown key with `notFound()`, so this is the narrow case where the editor
 * scaffolded a different plan than the link was written against, and the honest
 * answer is to open no drawer rather than the wrong one.
 */
function rowOfKey(
  phases: PhaseDraft[], key: string,
): { pi: number; ti?: number; si?: number } | null {
  for (let pi = 0; pi < phases.length; pi += 1) {
    if (phases[pi].key === key) return { pi };
    const tasks = phases[pi].tasks;
    for (let ti = 0; ti < tasks.length; ti += 1) {
      if (tasks[ti].key === key) return { pi, ti };
      const kids = tasks[ti].children ?? [];
      for (let si = 0; si < kids.length; si += 1) {
        if (kids[si].key === key) return { pi, ti, si };
      }
    }
  }
  return null;
}

export function PlanBuildEditor({
  projectId, initialPhases, templateBody, parties = [], savedStageKeys = [], openStageKey = null,
}: {
  projectId: string;
  /** An existing saved draft to resume editing; absent → scaffold from the template. */
  initialPhases?: PhaseDraft[];
  /**
   * The caller's resolved default scaffold (names only), read server-side by the
   * page. Absent only when that read failed — then the built-in skeleton stands
   * in, so an unreachable template still leaves a usable editor.
   */
  templateBody?: TemplatePhase[];
  /** The project's members — the ONLY parties a stage may be assigned to. */
  parties?: PartyRef[];
  /**
   * The stage keys the SERVER holds for this build (LINA-250). A task's
   * workspace — its comments and files — only exists for these: a row the author
   * just added has a local key and no stage behind it, so its section says "save
   * the plan first" rather than opening a thread every write would 404 on.
   */
  savedStageKeys?: string[];
  /** The task a permalink asked for, opened in the drawer on mount. */
  openStageKey?: string | null;
}) {
  const router = useRouter();
  const resuming = initialPhases != null && initialPhases.length > 0;

  // The scaffold this editor starts from, and the one "Reset" returns to — the
  // two must be the same source or reset would quietly swap the author's default
  // for a different plan than the one they opened.
  const seed = useCallback(
    () => (templateBody?.length ? seedFromTemplate(templateBody) : seedSkeleton()),
    [templateBody],
  );

  // Resume an existing draft, else scaffold from the resolved default. Both mint
  // fresh React keys, so this must run in a lazy initialiser, not every render.
  const [phases, setPhases] = useState<PhaseDraft[]>(() => initialPhases ?? seed());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // "Save as my default" — a private preference write, tracked apart from the
  // plan save so its confirmation can never be mistaken for "the plan was sent".
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultSaved, setDefaultSaved] = useState(false);

  // Today anchors the timeline's fallback window for an undated plan. Captured
  // once per mount — a plan authored across midnight keeps its canvas.
  const [todayIso] = useState(() => new Date().toISOString().slice(0, 10));

  // The detail drawer (LINA-234). Holds the open row's index: {pi} alone for a
  // PHASE (LINA-248 — phases open the same drawer, minus dates/description),
  // plus `ti` for a task and `si` for a sub-task (LINA-243).
  // Opened on mount when a permalink named a task (LINA-250) — the row is found
  // in the hydrated draft, whose keys are the server's since LINA-250 made
  // hydration reuse them.
  const [openRow, setOpenRow] = useState<{ pi: number; ti?: number; si?: number } | null>(
    () => (openStageKey ? rowOfKey(initialPhases ?? [], openStageKey) : null),
  );
  const activePhase = openRow ? phases[openRow.pi] ?? null : null;
  const activeTask = openRow?.ti != null ? activePhase?.tasks[openRow.ti] ?? null : null;
  const active = openRow?.si != null ? activeTask?.children[openRow.si] ?? null : activeTask;
  const activeKey = openRow?.ti == null ? activePhase?.key : active?.key;

  // "Depends on" (LINA-233). `openDeps` is the key of the row whose picker is
  // open — one at a time. `serverCycle` holds the stages the SERVER named on a
  // 409: it is the authority on the graph, and its answer outlives our own
  // check, so the offending rows stay lit until edited.
  const [openDeps, setOpenDeps] = useState<string | null>(null);
  const [serverCycle, setServerCycle] = useState<Array<{ key: string | null; name: string }>>([]);

  // ── The address bar follows the drawer (LINA-250, Jira behaviour) ──────────
  // Opening a SAVED task puts its permalink in the address bar, so the URL is
  // always the thing to share; closing puts the plan back. replaceState, not
  // push and not router.replace: a Next navigation would re-render the page and
  // throw away the unsaved draft in this editor, and stacking a history entry
  // per row would turn Back into an undo of clicks nobody made.
  const saved = useMemo(() => new Set(savedStageKeys), [savedStageKeys]);
  const workspaceKey = activeKey && saved.has(activeKey) ? activeKey : null;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = workspaceKey ? taskPath(projectId, workspaceKey) : `/projects/${projectId}/plan/build`;
    if (window.location.pathname !== next) window.history.replaceState(null, '', next);
  }, [projectId, workspaceKey]);

  // A fresh task means a fresh link — the "Copied" flash must not carry over.
  useEffect(() => { setCopied(false); }, [workspaceKey]);

  const copyLink = useCallback(async () => {
    if (!workspaceKey) return;
    const url = `${window.location.origin}${taskPath(projectId, workspaceKey)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard permission (or an insecure context): the address bar
      // already holds this exact URL, so say that rather than fail silently.
      setError('Copy from the address bar — this browser did not allow the copy.');
    }
  }, [projectId, workspaceKey]);

  const count = useMemo(() => taskCount(phases), [phases]);
  const subs = useMemo(() => subtaskCount(phases), [phases]);
  const index = useMemo(() => nodeIndex(phases), [phases]);
  const dir = useMemo(() => partyIndex(parties), [parties]);

  // The picker already refuses a choice that would loop, so this should never
  // fire — it is the belt to that braces: "Save plan" stays disabled while a
  // cycle exists (contract §4) rather than firing a request certain to 409.
  const cycle = useMemo(() => detectCycle(phases), [phases]);
  const litRows = useMemo(() => new Set<string>([
    ...(cycle ?? []).map((n) => n.key),
    ...serverCycle.map((s) => s.key).filter((k): k is string => typeof k === 'string'),
  ]), [cycle, serverCycle]);

  // Every mutation goes through here so a fresh edit always clears a stale error
  // — and a stale "saved as your default", which described a structure the author
  // has since changed and would otherwise read as though the edit was saved too.
  const apply = useCallback((next: PhaseDraft[]) => {
    setPhases(next);
    setError(null);
    setDefaultSaved(false);
    setServerCycle([]);
  }, []);

  const toggleDep = useCallback((nodeKey: string, dep: string) => {
    apply(toggleDependency(phases, nodeKey, dep));
  }, [apply, phases]);

  // Re-typing a link is a plan edit like any other: same `apply`, so a stale
  // cycle error clears the moment the author touches the graph.
  const retypeDep = useCallback((nodeKey: string, dep: string, type: DepType) => {
    apply(setDependencyType(phases, nodeKey, dep, type));
  }, [apply, phases]);

  const assign = useCallback((nodeKey: string, partyId: string | null) => {
    apply(setAssignee(phases, nodeKey, partyId));
  }, [apply, phases]);

  const retrade = useCallback((nodeKey: string, trade: string) => {
    apply(setTrade(phases, nodeKey, trade));
  }, [apply, phases]);

  // Back to the scaffold this editor opened on — the caller's resolved default,
  // not the hard-coded skeleton. Purely client-side: it discards unsaved edits in
  // this tab and writes nothing.
  const reset = useCallback(() => apply(seed()), [apply, seed]);

  // PUT the current structure as the caller's one default (ADR-0018). Names only:
  // toTemplateBody drops dates and descriptions, which belong to this build and
  // not to the shape. A second save replaces the first.
  const saveAsDefault = useCallback(async () => {
    setError(null);
    setDefaultSaved(false);
    let body;
    try {
      body = toTemplateBody(phases);
    } catch (e) {
      setError(e instanceof PlanAuthorError ? e.message : 'Something is off with the plan.');
      return;
    }
    setSavingDefault(true);
    try {
      await saveMyDefaultTemplate(body);
      setDefaultSaved(true);
    } catch (e) {
      setError(e instanceof PlanAuthorError ? e.message : 'That did not save. Try again.');
    } finally {
      setSavingDefault(false);
    }
  }, [phases]);

  const rename = useCallback((value: string, pi: number, ti?: number, si?: number) => {
    apply(ti == null
      ? renamePhase(phases, pi, value)
      : si == null
        ? renameTask(phases, pi, ti, value)
        : renameSubtask(phases, pi, ti, si, value));
  }, [apply, phases]);

  const setDate = useCallback((
    field: 'start' | 'end', value: string, pi: number, ti: number, si?: number,
  ) => {
    apply(si == null
      ? setTaskDate(phases, pi, ti, field, value)
      : setSubtaskDate(phases, pi, ti, si, field, value));
  }, [apply, phases]);

  // A Gantt drag or an empty-track click lands here: write the row's start and
  // finish in one op. Same draft, same tested vocabulary the table's date
  // inputs use — the timeline just computes the dates from a pointer.
  const setDates = useCallback((
    pi: number, ti: number, start: string, end: string, si?: number,
  ) => {
    apply(si == null
      ? setTaskDates(phases, pi, ti, start, end)
      : setSubtaskDates(phases, pi, ti, si, start, end));
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
      // The project's member list is the picker's whole universe, so this should
      // not be reachable — but a member removed from the build between the page
      // load and the save makes it reachable, and the honest answer is to name
      // the cause rather than restate the server's field-level wording.
      if (e instanceof PlanAuthorError
        && (e.code === 'unknown_assignee' || e.code === 'invalid_assignee')) {
        setError('One of the owners on this plan is no longer on this build. Reload the page and pick again.');
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

  const activeOwner = partyOf(dir, (openRow?.ti == null ? activePhase?.assigneePartyId : active?.assigneePartyId) ?? null);

  return (
    <main className="pbx pbx--grid">
      <header className="pbx-head">
        <div>
          <p className="pbx-eyebrow">{resuming ? 'Your draft' : 'New plan'}</p>
          <h1 className="pbx-title">Build the plan directly in LinkNMS</h1>
          <p className="pbx-lede">
            Compose phases and tasks, assign an accountable specialty and owner, and set the dates
            by clicking and dragging the bars — or leave what you don’t know blank. Saving keeps
            this as your private draft — only you can see it, and nothing is sent until you choose
            to send it for approval.
          </p>
        </div>
        <span className="pbx-draft">Draft — only you can see it</span>
      </header>

      <div className="pbx-toolbar">
        <p className="pbx-count">
          {count} {count === 1 ? 'task' : 'tasks'} across {phases.length}{' '}
          {phases.length === 1 ? 'phase' : 'phases'}
          {subs > 0 ? ` · ${subs} ${subs === 1 ? 'sub-task' : 'sub-tasks'}` : ''}
        </p>
        <div className="pbx-tools">
          {/* The light confirmation. Worded so it cannot be read as "sent": this
              saved a private starting point for the author's NEXT build, and did
              nothing at all to this plan. */}
          {defaultSaved ? (
            <span role="status" className="pbx-saved">Saved as your default — your next build starts here.</span>
          ) : null}
          <button type="button" className="pbx-icon" onClick={reset}
            disabled={submitting || savingDefault}
            title="Start over from your default plan" style={{ width: 'auto', padding: '0 10px' }}>
            Reset to skeleton
          </button>
          <button type="button" className="pbx-icon" onClick={saveAsDefault}
            disabled={submitting || savingDefault}
            title="Reuse this structure — phase and task names only — on your next build"
            style={{ width: 'auto', padding: '0 10px' }}>
            {savingDefault ? 'Saving…' : 'Save as my default'}
          </button>
        </div>
      </div>

      {/* The add callbacks return the FRESH node's key (add ops append, so it
          is always the last one) — the grid opens rename on it focused
          (founder follow-up, 2026-09-11). */}
      <PlanGrid
        phases={phases}
        parties={parties}
        litRows={litRows}
        disabled={submitting}
        todayIso={todayIso}
        onOpenRow={(pi, ti, si) => setOpenRow({ pi, ti, si })}
        onRename={rename}
        onSetDate={setDate}
        onDates={setDates}
        onAssign={assign}
        onTrade={retrade}
        onAddPhase={() => {
          const next = addPhase(phases);
          apply(next);
          return next[next.length - 1].key;
        }}
        onAddTask={(pi) => {
          const next = addTask(phases, pi);
          apply(next);
          return next[pi].tasks[next[pi].tasks.length - 1].key;
        }}
        onAddSubtask={(pi, ti) => {
          const next = addSubtask(phases, pi, ti);
          apply(next);
          const kids = next[pi].tasks[ti].children ?? [];
          return kids[kids.length - 1].key;
        }}
        onRemovePhase={(pi) => apply(removePhase(phases, pi))}
        onRemoveTask={(pi, ti) => apply(removeTask(phases, pi, ti))}
        onRemoveSubtask={(pi, ti, si) => apply(removeSubtask(phases, pi, ti, si))}
        onReorderPhase={(from, to) => apply(reorderPhase(phases, from, to))}
        onReorderTask={(pi, from, to) => apply(reorderTask(phases, pi, from, to))}
        onReorderSubtask={(pi, ti, from, to) => apply(reorderSubtask(phases, pi, ti, from, to))}
        onPromote={(pi, ti, si) => apply(promoteNode(phases, pi, ti, si))}
        onDemote={(pi, ti, si) => apply(demoteNode(phases, pi, ti, si))}
      />

      <p className="pgd-hint">
        ↔ Drag a bar to move a task; drag its edges to change start or finish — the Start and
        Finish columns update automatically. Click an undated row’s timeline to schedule it: the
        bar starts on the clicked day and runs one week. Click a row to open its details.
      </p>

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

      {openRow && activePhase && (openRow.ti == null || active) ? (
        <div
          className="pbx-drawer-scrim"
          role="presentation"
          onClick={() => { setOpenRow(null); setOpenDeps(null); }}
        >
          <aside
            className="pbx-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={openRow.ti == null ? 'Phase details' : openRow.si != null ? 'Sub-task details' : 'Task details'}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="pbx-drawer-hd">
              <div>
                <p className="pbx-drawer-eyebrow">
                  {openRow.ti == null ? 'Phase details' : openRow.si != null ? 'Sub-task details' : 'Task details'}
                </p>
                <h2 className="pbx-drawer-title">
                  {(openRow.ti == null ? activePhase.name : active!.name).trim()
                    || (openRow.ti == null ? 'Untitled phase' : openRow.si != null ? 'Untitled sub-task' : 'Untitled task')}
                </h2>
                {openRow.si != null && activeTask ? (
                  <p className="pbx-drawer-under">
                    Under {activeTask.name.trim() || 'an untitled task'}
                  </p>
                ) : null}
              </div>
              <div className="pbx-drawer-hdtools">
                {/* Shown only for a SAVED task: a link to a row that exists
                    nowhere but this tab would open a 404 for whoever got it. */}
                {workspaceKey ? (
                  <button
                    type="button"
                    className="pbx-icon tws-copy"
                    title="Copy this task’s link"
                    aria-label="Copy this task’s link"
                    onClick={() => void copyLink()}
                  >
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="pbx-icon"
                  title="Close"
                  aria-label="Close details"
                  onClick={() => { setOpenRow(null); setOpenDeps(null); }}
                >✕</button>
              </div>
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

            <div className="pbx-drawer-meta">
              <span className="pbx-drawer-label">Owner</span>
              <span className="pbx-owner">
                {activeOwner ? <PartyAvatar party={activeOwner} size="md" /> : <UnassignedAvatar size="md" />}
                <select
                  className="pbx-ownersel"
                  value={(openRow.ti == null ? activePhase.assigneePartyId : active!.assigneePartyId) ?? ''}
                  aria-label="Owner"
                  disabled={submitting || parties.length === 0}
                  onChange={(e) => activeKey && assign(activeKey, e.target.value || null)}
                >
                  <option value="">Unassigned</option>
                  {parties.map((p) => (
                    <option key={p.partyId} value={p.partyId}>{p.name} · {roleWord(p.role)}</option>
                  ))}
                </select>
              </span>

              <span className="pbx-drawer-label">Specialty</span>
              <input
                className="pbx-tradeinput"
                value={openRow.ti == null ? activePhase.trade : active!.trade}
                placeholder="e.g. Electrical"
                maxLength={120}
                aria-label="Specialty (trade)"
                disabled={submitting}
                onChange={(e) => activeKey && retrade(activeKey, e.target.value)}
              />

              {openRow.ti != null && active ? (
                <>
                  <span className="pbx-drawer-label">Start</span>
                  <input
                    type="date" className="pbx-date" value={active.start}
                    aria-label="Start date" disabled={submitting}
                    onChange={(e) => setDate('start', e.target.value, openRow.pi, openRow.ti!, openRow.si)}
                  />
                  <span className="pbx-drawer-label">Finish</span>
                  <input
                    type="date" className="pbx-date" value={active.end}
                    aria-label="Finish date" disabled={submitting}
                    onChange={(e) => setDate('end', e.target.value, openRow.pi, openRow.ti!, openRow.si)}
                  />
                </>
              ) : null}

              <span className="pbx-drawer-label">Scheduling links</span>
              {activeKey ? (
                <SchedulingLinks
                  nodeKey={activeKey}
                  label={index.get(activeKey)?.label ?? 'this stage'}
                  phases={phases}
                  index={index}
                  open={openDeps === activeKey}
                  disabled={submitting}
                  onOpen={(next) => setOpenDeps(next ? activeKey : null)}
                  onToggle={(dep) => toggleDep(activeKey, dep)}
                  onRetype={(dep, type) => retypeDep(activeKey, dep, type)}
                />
              ) : null}
            </div>

            {openRow.ti != null && active ? (
              <>
                <label className="pbx-drawer-label" htmlFor="pbx-task-desc">Description</label>
                <textarea
                  id="pbx-task-desc"
                  className="pbx-drawer-desc"
                  value={active.description}
                  placeholder="What is this task? Add scope, context, anything the other party should know."
                  maxLength={4000}
                  disabled={submitting}
                  onChange={(e) => apply(openRow.si != null
                    ? setSubtaskDescription(phases, openRow.pi, openRow.ti!, openRow.si, e.target.value)
                    : setTaskDescription(phases, openRow.pi, openRow.ti!, e.target.value))}
                />
              </>
            ) : (
              <p className="pbx-status-hint">
                A phase’s dates are read off its tasks — schedule those and the phase bar follows.
              </p>
            )}

            {/* The task workspace (LINA-250): the conversation and the files on
                this task. `workspaceKey` is null until the plan holds this row —
                the section then says so rather than collecting comments locally
                that no reload would bring back. */}
            <TaskWorkspace projectId={projectId} stageKey={workspaceKey} parties={parties} />

            <div className="pbx-drawer-actions">
              <button type="button" className="btn primary"
                onClick={() => { setOpenRow(null); setOpenDeps(null); }}>Done</button>
            </div>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
