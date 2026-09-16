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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import {
  DEP_HINTS, DEP_LABELS, DEP_TYPES, PlanAuthorError,
  addPhase, addSubtask, addTask, authorPlan, demoteNode, dependencyChoices, dependsOnOf, detectCycle, enforceDependencies, nodeIndex,
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
  importHref = null,
}: {
  projectId: string;
  /**
   * Where the "import a spreadsheet instead" link points, or null to hide it.
   * The plan page passes it only for the GC (importing is theirs, B1 §5) — the
   * editor is now the plan's landing surface, so this is the door to the import
   * route the old empty-plan chooser used to hold.
   */
  importHref?: string | null;
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

  // ── Autosave (LINA-306) ─────────────────────────────────────────────────────
  // The founder asked for no Save button: "any change we make a post request".
  // Taken literally — one POST per keystroke or per pointermove of a drag — that
  // would append one `plan_drafted` ledger event PER micro-edit and drown the
  // audit trail, whose integrity is the product's whole reason to exist. So a
  // change schedules a DEBOUNCED write: a burst of typing or a whole drag settles
  // into ONE authorPlan() call (~900ms after the last edit), which is exactly one
  // honest "draft saved at T" on the ledger. Saving is still PRIVATE drafting
  // (LINA-230) — the other party sees nothing; "Send for approval" stays a
  // separate, deliberate act on the plan page.
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);   // a write is in flight
  const pendingRef = useRef(false);  // an edit landed mid-write — save again after
  const phasesRef = useRef(phases);  // the latest tree, read by the debounced flush

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
  // Stage keys the SERVER holds. State, not a memo: a successful autosave adds
  // the tree's keys here, so a row the author just added lights up its workspace
  // (comments/files) without a reload once its draft write lands.
  const [savedKeys, setSavedKeys] = useState<Set<string>>(() => new Set(savedStageKeys));
  const saved = savedKeys;
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
    phasesRef.current = next;
    setError(null);
    setDefaultSaved(false);
    setServerCycle([]);
    // Debounce the write: a whole drag or a burst of typing collapses to one
    // draft save once the author pauses (see the autosave note above).
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { flushRef.current(); }, 900);
  }, []);

  // Edits that touch a DATE or a LINK go through here (LINA-306): after the pure
  // op, enforceDependencies snaps every dependent's schedule back onto its
  // predecessors so a "starts when that one ends" link is not just drawn but
  // OBEYED — and re-obeyed when the predecessor moves. Pure and cycle-safe, so it
  // is the same `apply` pipeline, only fed a graph that already honours its links.
  const applyDeps = useCallback((next: PhaseDraft[]) => {
    apply(enforceDependencies(next));
  }, [apply]);

  // The debounced writer. Reads the LATEST tree from the ref (a stale closure
  // would save the plan as it was when the timer was armed, not as it settled).
  const flushRef = useRef<() => void>(() => {});
  const flush = useCallback(async () => {
    const current = phasesRef.current;
    // Never fire a write the server is certain to 409: a cycle is already spelled
    // out in the alert, and "Save" used to sit disabled on it — autosave simply
    // holds until the author breaks the loop, when the next edit re-arms it.
    if (detectCycle(current)) return;
    let stages;
    try {
      stages = toWire(current);
    } catch (e) {
      setError(e instanceof PlanAuthorError ? e.message : 'Something is off with the plan.');
      return;
    }
    // Coalesce concurrent writes: if one is in flight, mark that another edit is
    // pending and let the in-flight one re-run flush when it settles.
    if (savingRef.current) { pendingRef.current = true; return; }
    savingRef.current = true;
    setSaveState('saving');
    try {
      await authorPlan(projectId, stages);
      // Light up every current row's workspace: after this write the server holds
      // them all, so a freshly-added task can collect comments/files immediately.
      setSavedKeys((prev) => {
        const nextKeys = new Set(prev);
        const eat = (k: string) => nextKeys.add(k);
        current.forEach((p) => {
          eat(p.key);
          p.tasks.forEach((t) => { eat(t.key); (t.children ?? []).forEach((s) => eat(s.key)); });
        });
        return nextKeys;
      });
      setSaveState('saved');
    } catch (e) {
      if (e instanceof PlanAuthorError && (e.code === 'open_plan_exists' || e.code === 'draft_exists')) {
        // The draft is not this screen's to write anymore — send the author to
        // the live plan rather than autosave into a wall.
        router.push(`/projects/${projectId}/plan`);
        return;
      }
      if (e instanceof PlanAuthorError && e.code === 'dependency_cycle') {
        const stagesOnCycle = e.details?.stages ?? [];
        setServerCycle(stagesOnCycle);
        setError(stagesOnCycle.length
          ? `These stages depend on each other in a loop: ${stagesOnCycle.map((s) => s.name).join(' → ')} → ${stagesOnCycle[0].name}. Remove one of the links to save.`
          : e.message);
      } else if (e instanceof PlanAuthorError
        && (e.code === 'unknown_assignee' || e.code === 'invalid_assignee')) {
        setError('One of the owners on this plan is no longer on this build. Reload the page and pick again.');
      } else {
        setError(e instanceof PlanAuthorError ? e.message : 'That did not save. Your edits are still here — they will retry on the next change.');
      }
      setSaveState('error');
    } finally {
      savingRef.current = false;
      // An edit that landed mid-write is now unsaved — flush again for it.
      if (pendingRef.current) { pendingRef.current = false; void flushRef.current(); }
    }
  }, [projectId, router]);

  useEffect(() => { flushRef.current = flush; }, [flush]);
  // Flush a still-pending debounce on unmount so the last edit is never lost when
  // the author navigates away right after typing.
  useEffect(() => () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); void flushRef.current(); }
  }, []);

  const toggleDep = useCallback((nodeKey: string, dep: string) => {
    applyDeps(toggleDependency(phases, nodeKey, dep));
  }, [applyDeps, phases]);

  // Re-typing a link is a plan edit like any other — and now re-enforces the
  // dependent's dates against its new rule (LINA-306): flip starts_after to
  // ends_with and the bar re-snaps the moment the type changes.
  const retypeDep = useCallback((nodeKey: string, dep: string, type: DepType) => {
    applyDeps(setDependencyType(phases, nodeKey, dep, type));
  }, [applyDeps, phases]);

  // Clear ONE link — the drawer chip's ✕ and now the unlink control that sits in
  // the middle of the Gantt arrow (LINA-306). toggleDependency removes an existing
  // edge; enforcement then leaves the freed stage where it is (a released
  // dependent keeps its last dates — no constraint, no move).
  const unlinkDep = useCallback((fromKey: string, toKey: string) => {
    applyDeps(toggleDependency(phases, fromKey, toKey));
  }, [applyDeps, phases]);

  // Draw-a-dependency on the Gantt (LINA-306): the author drags from one bar's
  // edge to another's, and the pair of edges names the type (start→end after,
  // start→start with, end→end ends-with). `fromKey` is the DEPENDENT — it carries
  // the link, exactly as the drawer's picker does. Upsert, not toggle: dragging
  // onto a stage this one already waits on RE-TYPES the link rather than removing
  // it, so re-dragging to correct the edge never silently deletes the link.
  const linkDep = useCallback((fromKey: string, toKey: string, type: DepType) => {
    if (fromKey === toKey) return;
    const exists = dependsOnOf(phases, fromKey).some((d) => d.on === toKey);
    const created = exists ? phases : toggleDependency(phases, fromKey, toKey);
    // enforceDependencies is what makes "starts when that one ends" real: the
    // link is created here AND the dependent's dates are snapped to obey it, so a
    // fresh drag-to-link reschedules the bar in the same gesture (LINA-306).
    applyDeps(setDependencyType(created, fromKey, toKey, type));
    setOpenDeps(null);
  }, [applyDeps, phases]);

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
    applyDeps(si == null
      ? setTaskDate(phases, pi, ti, field, value)
      : setSubtaskDate(phases, pi, ti, si, field, value));
  }, [applyDeps, phases]);

  // A Gantt drag or an empty-track click lands here: write the row's start and
  // finish in one op. Same draft, same tested vocabulary the table's date
  // inputs use — the timeline just computes the dates from a pointer.
  const setDates = useCallback((
    pi: number, ti: number, start: string, end: string, si?: number,
  ) => {
    applyDeps(si == null
      ? setTaskDates(phases, pi, ti, start, end)
      : setSubtaskDates(phases, pi, ti, si, start, end));
  }, [applyDeps, phases]);

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
          {/* The autosave indicator — the founder removed the Save button, so this
              is the only signal a write happened. Quiet by design: it states, it
              never blocks. */}
          <span role="status" className={`pbx-autosave is-${saveState}`}>
            {saveState === 'saving' ? 'Saving…'
              : saveState === 'saved' ? 'All changes saved · draft only you can see'
                : saveState === 'error' ? 'Not saved — will retry on your next edit'
                  : 'Changes save automatically'}
          </span>
          {/* The light confirmation. Worded so it cannot be read as "sent": this
              saved a private starting point for the author's NEXT build, and did
              nothing at all to this plan. */}
          {defaultSaved ? (
            <span role="status" className="pbx-saved">Saved as your default — your next build starts here.</span>
          ) : null}
          {importHref ? (
            <Link className="pbx-icon" href={importHref}
              title="Bring the plan in from a spreadsheet instead"
              style={{ width: 'auto', padding: '0 10px', display: 'inline-flex', alignItems: 'center' }}>
              Import a spreadsheet
            </Link>
          ) : null}
          <button type="button" className="pbx-icon" onClick={reset}
            disabled={savingDefault}
            title="Start over from your default plan" style={{ width: 'auto', padding: '0 10px' }}>
            Reset to skeleton
          </button>
          <button type="button" className="pbx-icon" onClick={saveAsDefault}
            disabled={savingDefault}
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
        disabled={false}
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
        onLinkDep={linkDep}
        onUnlinkDep={unlinkDep}
      />

      <p className="pgd-hint">
        ↔ Drag a bar to move a task; drag its edges to change start or finish. Hover a bar to see its
        dates on each edge and the <strong>＋</strong> handles — drag a handle onto another bar’s edge
        to link them (left→right = starts after it finishes, left→left = starts together, right→right =
        finishes together). Click an undated row’s timeline to schedule it. Click a row to open its details.
      </p>

      {cycle ? (
        <p role="alert" className="pbx-cycle">
          <strong>These stages wait on each other in a loop:</strong>{' '}
          {cycle.map((n) => n.label).join(' → ')} → {cycle[0].label}. Remove one of the links to save.
        </p>
      ) : null}

      {error ? <p role="alert" className="pbx-open">{error}</p> : null}

      {/* No Save, no Cancel (founder, LINA-306): every edit autosaves as your
          private draft. "Send for approval" stays a separate act on the plan. */}
      <div className="pbx-actions">
        <Link className="btn" href={`/projects/${projectId}/plan`}>View plan &amp; send for approval →</Link>
      </div>

      <p className="pbx-foot">
        Your changes save automatically as a private draft — only you can see them, and each save
        records one event on the shared record that the draft was saved. Nothing is sent to the other
        party and no approval is requested until you choose <strong>Send for approval</strong> on the
        plan page.
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
                  disabled={parties.length === 0}
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
                disabled={false}
                onChange={(e) => activeKey && retrade(activeKey, e.target.value)}
              />

              {openRow.ti != null && active ? (
                <>
                  <span className="pbx-drawer-label">Start</span>
                  <input
                    type="date" className="pbx-date" value={active.start}
                    aria-label="Start date" disabled={false}
                    onChange={(e) => setDate('start', e.target.value, openRow.pi, openRow.ti!, openRow.si)}
                  />
                  <span className="pbx-drawer-label">Finish</span>
                  <input
                    type="date" className="pbx-date" value={active.end}
                    aria-label="Finish date" disabled={false}
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
                  disabled={false}
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
                  disabled={false}
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
