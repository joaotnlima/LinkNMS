'use client';

// The "Build the plan here" editor (LINA-228, ADR-0017).
//
// Pen: "S · (new) · Build the plan — schedule (Gantt)" / "Interaction spec —
// Create & organise tasks". The screen is copy + layout only — every edit is a
// pure operation from @/lib/plan-authoring (unit-tested under node --test), and
// the single write is the v2 autosave. Up to five levels (ADR-0019, lifted from
// three by PRD-01 G-1): a phase holds tasks, a task holds sub-tasks, and so on
// down to MAX_DEPTH. The screen refuses a sixth level by never drawing an "add"
// for it; every tree op is path-addressed so each level behaves the same.
//
// PRD-01 P-1/P-2: the task detail is a DOCKED right panel (480px, 640px when a
// step needs room), not an overlay — the grid stays visible, undimmed and
// clickable, and clicking another row switches the panel. It has four tabs,
// Plan · Tender · Conversation · Files, each label carrying its state.
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
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import {
  DEP_HINTS, DEP_LABELS, DEP_TYPES, PlanAuthorError,
  addChildAt, addPhase, breakdownOf, canAddChildAt, criticalPathKeys, demoteAt, dependencyChoices, dependsOnOf, detectCycle,
  enforceDependencies, enforceLink, enforceParentRollup, nodeAtPath, nodeIndex, nodeStatus, pathOfKey,
  promoteAt, removeAt, renameAt, reorderAt,
  saveMyDefaultTemplate, seedFromTemplate, seedSkeleton,
  setAssignee, setDateAt, setDatesAt, setDependencyType, setDescriptionAt, setTrade, shiftGroup,
  subtaskCount, taskAtPath, taskCount, toggleDependency, toTemplateBody, toWire,
  type AuthoredNode, type DepType, type NodePath, type PhaseDraft, type PlanNodeRef, type StageStatus, type TaskDraft,
  type TemplatePhase,
} from '@/lib/plan-authoring';
import { rekeyDraft, rekeyWire, draftKeys } from '@/lib/v2/plan-rekey';
import { procurementChip, procurementTabLabel, type ProcurementRfp } from '@/lib/plan-gantt';
import { partyIndex, type PartyRef } from '@/lib/party-display';
import { TaskWorkspace } from '@/components/TaskWorkspace';
import { TaskFiles, type TaskFilesSummary } from '@/components/files/TaskFiles';
import { filesTabLabel } from '@/lib/v2/task-files-view';
import { taskHref, planHref } from '@/lib/task-workspace';
import { PlanGrid } from './PlanGrid';
import {
  StatusPicker, OwnerField, SpecialtyField, useSpecialtyCatalog,
} from './plan-fields';
import { ProcurementSection, type TaskOption } from '@/components/ProcurementSection';
import { TenderPanel, type PanelCounts, type WorkspaceSection } from '@/components/tender/TenderPanel';
import type { V2Rfp } from '@/lib/v2/tendering-view';
import { governingRfp, procurementFromRfp, type PanelFace } from '@/lib/v2/tender-flow-view';
import type { PlanSlipView } from '@/lib/v2/slip-view';
import { SlipHeader } from '@/components/SlipHeader';
import { ChangesPanel } from '@/components/ChangesPanel';
import { TaskSlipSection, type PendingMove } from '@/components/TaskSlipSection';
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
 * Where a key sits in the status hierarchy (LINA-404 FIX 1): its ANCESTOR keys
 * (phase first, then each task down), its descendant LEAF keys, whether it HAS
 * children, and the node itself — at any depth (PRD-01 G-1). Null when the key
 * names nothing here. Used by the status cascade — marking a parent done fans
 * out to its leaves, and reopening a leaf reopens its done ancestors.
 */
function locateStatusNode(
  phases: PhaseDraft[], key: string,
): { ancestors: string[]; descendantLeaves: string[]; hasChildren: boolean; node: PhaseDraft | TaskDraft } | null {
  const path = pathOfKey(phases, key);
  if (!path) return null;
  const node = nodeAtPath(phases, path);
  if (!node) return null;
  const ancestors: string[] = [];
  for (let d = 1; d < path.length; d += 1) {
    const a = nodeAtPath(phases, path.slice(0, d));
    if (a) ancestors.push(a.key);
  }
  const leaves: string[] = [];
  const collect = (t: TaskDraft) => {
    const kids = t.children ?? [];
    if (kids.length) kids.forEach(collect); else leaves.push(t.key);
  };
  const children = 'tasks' in node ? node.tasks : (node.children ?? []);
  children.forEach(collect);
  return { ancestors, descendantLeaves: leaves, hasChildren: children.length > 0, node };
}

/** The status of a node by key — a phase/task derives nothing here (status is the
 *  reported leaf value), so we read `.status` off a task/sub and treat a phase as
 *  having none. Used only to decide whether a DONE ancestor needs reopening. */
function statusOfKey(phases: PhaseDraft[], key: string): StageStatus | null {
  const loc = locateStatusNode(phases, key);
  if (!loc) return null;
  return 'tasks' in loc.node ? (loc.node as PhaseDraft & { status?: StageStatus }).status ?? null : nodeStatus(loc.node as TaskDraft);
}

/**
 * Write reported statuses into the draft tree by key (LINA-404). Status is NOT an
 * authored field — `toWire` never sends it — so this patch is PURELY local: it
 * lets a reported progress report show the moment it is posted, with NO page
 * reload (the founder's "the page should never refresh … each change saved
 * atomically"). Pure and copy-on-write: only the touched nodes (and their
 * ancestors' array spines) are rebuilt, and an update that changes nothing returns
 * the same ref. Every level is addressable (the cascade and the ancestor-reopen
 * both target mixed levels).
 */
function applyStatusPatch(phases: PhaseDraft[], updates: Map<string, StageStatus>): PhaseDraft[] {
  if (updates.size === 0) return phases;
  const patch = (t: TaskDraft): TaskDraft => {
    const before = t.children ?? [];
    const kids = before.map(patch);
    const kidsChanged = kids.some((k, i) => k !== before[i]);
    const ns = updates.get(t.key);
    const own = ns && ns !== t.status;
    if (!own && !kidsChanged) return t;
    return { ...t, ...(own ? { status: ns } : {}), children: kidsChanged ? kids : before };
  };
  let anyPhase = false;
  const nextPhases = phases.map((p) => {
    const tasks = p.tasks.map(patch);
    const phaseChanged = tasks.some((t, i) => t !== p.tasks[i]);
    const pns = updates.get(p.key);
    const cur = (p as PhaseDraft & { status?: StageStatus }).status;
    if (pns && pns !== cur) { anyPhase = true; return { ...p, status: pns, tasks } as PhaseDraft; }
    if (phaseChanged) { anyPhase = true; return { ...p, tasks }; }
    return p;
  });
  return anyPhase ? nextPhases : phases;
}

/**
 * The v2 autosave door (LINA-369, S3b). When present, the editor writes the plan
 * through `/api/v2` (the `savePlanV2` server action) instead of the v1
 * `authorPlan` fetch, and the write is INCREMENTAL: it hands the last-saved tree
 * (`prev`, null on the very first save of an empty build) and the tree it is
 * saving now (`next`), and the action diffs them. On success it returns the v2
 * ids the save minted for any rows it created (`stageIds`, by author-local key —
 * the editor rekeys those rows so the next diff targets the real id) and whether
 * a structural move needs a reload (`needsReload`). A refusal comes back as
 * `{ ok: false }` rather than throwing, so the author keeps their edits.
 */
export type SaveV2 = (
  prev: AuthoredNode[] | null,
  next: AuthoredNode[],
) => Promise<
  | { ok: true; stageIds: Record<string, string>; needsReload: boolean }
  | { ok: false; code: string; message: string }
>;

/**
 * The v2 progress-write door (LINA-384, Phase 12b.5). The status picker reports
 * an append-only progress report through `/api/v2` (the `reportProgressV2` server
 * action) instead of the retired v1 `reportProgress` fetch. `taskId` is the
 * stable v2 row id. A refusal comes back as `{ ok: false }` — the picker rolls
 * back and shows the reason inline — rather than throwing.
 */
export type ReportProgressV2 = (
  taskId: string,
  status: StageStatus,
) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;

export function PlanBuildEditor({
  projectId, initialPhases, templateBody, parties = [], savedStageKeys = [], openStageKey = null, openStageTab = null,
  importHref = null, procurementHref = null, initialStageIds = {}, saveV2, reportProgressV2,
  canStartTender = false, procurement = {},
  tenderInitialRfps = [], tenderTasks = [], tenderHasActiveOrg = true, slip,
}: {
  projectId: string;
  /**
   * Where the "import a spreadsheet instead" link points, or null to hide it.
   * The plan page passes it only for the GC (importing is theirs, B1 §5) — the
   * editor is now the plan's landing surface, so this is the door to the import
   * route the old empty-plan chooser used to hold.
   */
  importHref?: string | null;
  /**
   * Where the "Tendering" link points, or null to hide it: the tendering home
   * (/projects/{id}/tendering, PRD-08 H-1). The modal's "Open full page" appends
   * /rfps/{id} (or /rfps/new?task=) to it.
   */
  procurementHref?: string | null;
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
  /**
   * The live key→id map for the saved draft's stages (LINA-307). Seeds the
   * editor's lookup so a status can be set the moment a saved draft is resumed;
   * each autosave replaces it with the ids that save minted. Empty for a fresh
   * scaffold, so every row is "save first" (read-only status) until it lands.
   */
  initialStageIds?: Record<string, string>;
  /** The task a permalink asked for, opened in the drawer on mount. */
  openStageKey?: string | null;
  /** The panel tab that permalink asked for (`&tab=`, PRD-12 N-1), applied once on mount. */
  openStageTab?: 'tender' | 'conversation' | 'files' | null;
  /**
   * The v2 write door (LINA-369). Present → the editor autosaves through
   * `/api/v2` incrementally; absent → the legacy v1 `authorPlan` whole-tree write.
   */
  saveV2?: SaveV2;
  /**
   * The v2 progress-write door (LINA-384). Present → the status picker reports
   * through `/api/v2`; absent → the picker is inert (a v1-only mount holds no
   * live v2 stage ids, so no row is status-settable there anyway).
   */
  reportProgressV2?: ReportProgressV2;
  /**
   * True when the viewer may raise a tender (`org:tendering:issue`, LINA-407).
   * Gates the per-package "Start tendering" control on the grid: with it, each
   * top-level row offers a one-click deep-link into the composer pre-set to Light
   * (design); without it (or with no procurement door) the control is hidden.
   */
  canStartTender?: boolean;
  /**
   * The tendering⇄schedule bridge (LINA-413): the procurement window each
   * out-to-tender row paints on its Gantt bar, keyed by the v2 task id (= the
   * row's stable key). Read server-side from the project's live tenders; empty
   * for a build with nothing out to tender. Forwarded straight to the grid.
   */
  procurement?: Record<string, ProcurementRfp>;
  /**
   * The in-place tendering modal's server bootstrap (LINA-420). "Start tendering"
   * no longer navigates to /plan/procurement — it opens <ProcurementSection> in an
   * overlay over the plan, so the owner never leaves the plan screen. These are the
   * same reads that page did: the org's tenders for this build (`tenderInitialRfps`,
   * used to resolve an already-tendered task to its existing tender so it opens on
   * the responses + Compare, not a blank composer), the candidate tasks the
   * composer can tender over (`tenderTasks`, the whole WBS flattened), and whether
   * an org is selected (`tenderHasActiveOrg`, false → the "pick an org" state).
   */
  tenderInitialRfps?: V2Rfp[];
  tenderTasks?: TaskOption[];
  tenderHasActiveOrg?: boolean;
  /**
   * PRD-13: the server's changes against the baseline (segments, deltas, overrun,
   * handover, change count) from the same schedule read. Drives the clay on the
   * bars, the "vs baseline" column, the header, the Changes panel and the task
   * panel's block. Absent → the plan renders exactly as before.
   */
  slip?: PlanSlipView;
}) {
  const resuming = initialPhases != null && initialPhases.length > 0;
  // v2 mode (LINA-369): the save writes the build's live plan on the v2 record —
  // NOT the v1 private-draft-then-propose flow. The copy below drops the "only you
  // can see it" / "send for approval" framing accordingly (the v1 proposal /
  // sign-off step is a separate v2 slice, S6). See the header, footer and actions.
  const v2 = saveV2 != null;

  // The scaffold this editor starts from, and the one "Reset" returns to — the
  // two must be the same source or reset would quietly swap the author's default
  // for a different plan than the one they opened.
  const seed = useCallback(
    () => (templateBody?.length ? seedFromTemplate(templateBody) : seedSkeleton()),
    [templateBody],
  );

  // Resume an existing draft, else scaffold from the resolved default. Both mint
  // fresh React keys, so this must run in a lazy initialiser, not every render.
  // A resumed draft is rolled up FIRST (LINA-404, founder's ask): a plan authored
  // before the roll-up rule — or stored with a parent end behind a descendant's
  // (e.g. a sub-task dated later than its parent task) — opens ALREADY consistent,
  // so p1.1 covers its sub-tasks the moment the page loads, not only after the
  // next edit. Pure + idempotent: a plan that already holds the invariant comes
  // back the same ref, so a healthy draft is untouched (and the mount-heal below
  // stays a no-op, never fabricating a save on open).
  const [phases, setPhases] = useState<PhaseDraft[]>(
    () => (initialPhases ? enforceParentRollup(initialPhases) : seed()),
  );
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

  // The tree the LAST successful v2 save persisted — what the NEXT save diffs
  // against (LINA-369, v2 mode only; v1 ignores it). Null on a fresh empty build,
  // so the first save CREATES the whole tree (`applyPlanDraft`); seeded from a
  // resumed draft otherwise so the first edit diffs against what is stored. Kept
  // in sync on every save: rekeyed to the v2 ids the save minted for created rows,
  // so a create followed by an edit does not re-create the same rows.
  const lastSavedWireRef = useRef<AuthoredNode[] | null>(
    resuming ? toWire(initialPhases!) : null,
  );

  // "Save as my default" — a private preference write, tracked apart from the
  // plan save so its confirmation can never be mistaken for "the plan was sent".
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultSaved, setDefaultSaved] = useState(false);

  // Today anchors the timeline's fallback window for an undated plan. Captured
  // once per mount — a plan authored across midnight keeps its canvas.
  const [todayIso] = useState(() => new Date().toISOString().slice(0, 10));

  // The detail panel (LINA-234; docked since PRD-01 P-1). Holds the open row's
  // KEY, and derives its PATH each render — [pi] alone for a PHASE (LINA-248 —
  // phases open the same panel, minus dates/description), deeper for a task at
  // any level (PRD-01 G-1). Keyed, not indexed, so reordering / indenting other
  // rows never re-points the panel at a different task; a save that rekeys a
  // created row carries the panel along (see the flush).
  // Opened on mount when a permalink named a task (LINA-250) — the row is found
  // in the hydrated draft, whose keys are the server's since LINA-250 made
  // hydration reuse them; an unknown key opens nothing.
  const [openKey, setOpenKey] = useState<string | null>(
    () => (openStageKey && pathOfKey(initialPhases ?? [], openStageKey) ? openStageKey : null),
  );
  const openRow = useMemo<NodePath | null>(
    () => (openKey ? pathOfKey(phases, openKey) : null),
    [openKey, phases],
  );
  const setOpenRow = useCallback((path: NodePath | null) => {
    setOpenKey(path ? nodeAtPath(phasesRef.current, path)?.key ?? null : null);
  }, []);
  const isTaskRow = openRow != null && openRow.length >= 2;
  const activePhase = openRow ? phases[openRow[0]] ?? null : null;
  // The open TASK (level ≥ 2), or null for a phase / a stale path.
  const active = isTaskRow ? taskAtPath(phases, openRow!) : null;
  // The open task's parent task (level ≥ 3) — the panel's "Under …" line.
  const activeParent = openRow && openRow.length >= 3 ? taskAtPath(phases, openRow.slice(0, -1)) : null;
  const isSubRow = openRow != null && openRow.length >= 3;
  const activeKey = isTaskRow ? active?.key : activePhase?.key;

  // "Depends on" (LINA-233). `openDeps` is the key of the row whose picker is
  // open — one at a time. `serverCycle` holds the stages the SERVER named on a
  // 409: it is the authority on the graph, and its answer outlives our own
  // check, so the offending rows stay lit until edited.
  const [openDeps, setOpenDeps] = useState<string | null>(null);
  const [serverCycle, setServerCycle] = useState<Array<{ key: string | null; name: string }>>([]);

  // The "mark everything below done" confirm (LINA-404 FIX 1). Non-null while the
  // modal is open; holds the parent/phase key and the descendant LEAF keys the
  // cascade will each attribute a `done` progress report to.
  const [cascade, setCascade] = useState<{ nodeKey: string; leafKeys: string[] } | null>(null);

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
  // The live key→id lookup for setting a task's status (LINA-307). Seeded from the
  // page's last read, replaced on every autosave (which re-mints ids). A leaf's
  // status is settable exactly when this holds an id for its key.
  const [stageIdByKey, setStageIdByKey] = useState<Map<string, string>>(
    () => new Map(Object.entries(initialStageIds)),
  );
  const workspaceKey = activeKey && saved.has(activeKey) ? activeKey : null;
  // The v2 TASK id the workspace drawer reads/writes against (LINA-399). Same
  // resolution as `setStatus`: a hydrated existing row's node key IS the v2 id
  // (planning-hydrate), and a row created this session uses the id the save minted
  // (kept in stageIdByKey). Null until the plan holds this row.
  const workspaceTaskId = workspaceKey ? (stageIdByKey.get(workspaceKey) ?? workspaceKey) : null;
  const [copied, setCopied] = useState(false);

  // The panel is tabbed (LINA-420; four tabs since PRD-01 P-2): Plan (status,
  // owner, dates, links, description, breakdown), Tender (the per-task tender
  // summary), Conversation (the task's thread) and Files (the task's files). It
  // opens on Plan and resets there whenever a different row opens, so a tender
  // tab left open on one task does not bleed onto the next.
  const [drawerTab, setDrawerTab] = useState<'plan' | 'tender' | 'conversation' | 'files'>('plan');
  // "＋ Tender" on a grid row opens that row's panel straight on the Tender tab
  // (PRD-02: tendering starts in the panel); every other row change opens Plan.
  // A permalink's `&tab=` seeds it, so the first open lands on that tab (PRD-12 N-1).
  const pendingTabRef = useRef<'tender' | 'conversation' | 'files' | null>(openStageKey ? openStageTab : null);
  useEffect(() => { setDrawerTab(pendingTabRef.current ?? 'plan'); pendingTabRef.current = null; }, [activeKey]);
  // The open task's Files summary (PRD-05 F-1, F-16), reported by <TaskFiles>
  // once it loads: the tab label carries "n to review" or the file count, and the
  // status picker says done is blocked while a required deliverable is
  // unapproved (D-48 — the server refuses it regardless). Reset per row.
  const [filesSummary, setFilesSummary] = useState<TaskFilesSummary | null>(null);
  useEffect(() => { setFilesSummary(null); }, [activeKey]);
  const fileTabLabel = filesTabLabel(filesSummary?.fileCount ?? null, filesSummary?.toReview ?? 0);
  const taskNames = useMemo(() => new Map(tenderTasks.map((t) => [t.id, t.name])), [tenderTasks]);

  // Tender writes made in the panel (PRD-02) update the plan in place — the
  // RFP list and the per-task chip/band — without a navigation (which would
  // drop the editor's unsaved draft, LINA-404). The server reads replace these
  // on the next page load.
  const [rfpOverrides, setRfpOverrides] = useState<Record<string, V2Rfp>>({});
  const [procOverrides, setProcOverrides] = useState<Record<string, ProcurementRfp>>({});
  const allRfps = useMemo(() => {
    const known = new Set(tenderInitialRfps.map((r) => r.id));
    const fresh = Object.values(rfpOverrides).filter((r) => !known.has(r.id));
    return [...fresh, ...tenderInitialRfps.map((r) => rfpOverrides[r.id] ?? r)];
  }, [tenderInitialRfps, rfpOverrides]);
  const procurementView = useMemo(() => ({ ...procurement, ...procOverrides }), [procurement, procOverrides]);
  const onPanelRfp = useCallback((rfp: V2Rfp, counts: PanelCounts) => {
    setRfpOverrides((prev) => ({ ...prev, [rfp.id]: rfp }));
    setProcOverrides((prev) => {
      const next = { ...prev };
      for (const taskId of rfp.root_task_ids) {
        const before = next[taskId] ?? procurement[taskId];
        const same = before?.rfpId === rfp.id;
        next[taskId] = procurementFromRfp(rfp, {
          invited: counts.invited ?? (same ? before?.invitedCount : undefined),
          submitted: counts.submitted ?? (same ? before?.submittedCount : undefined),
          awardedTo: counts.awardedTo ?? (same ? before?.awardedTo : undefined),
          openQuestions: counts.openQuestions ?? (same ? before?.openQuestions : undefined),
        });
      }
      return next;
    });
  }, [procurement]);

  // The tender that governs the open task (the one the server's task-procurement
  // read named, else the newest live one). A phase never tenders.
  const activeRfp = useMemo(
    () => (activeKey && isTaskRow
      ? governingRfp(allRfps, activeKey, procurementView[activeKey]?.rfpId)
      : null),
    [activeKey, isTaskRow, allRfps, procurementView],
  );
  const [panelFace, setPanelFace] = useState<PanelFace>('none');
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>('overview');

  // Which rows drive the build's finish (CPM) — read off the SAME draft the grid
  // overlays, so the drawer's critical-path warning agrees with the grid toggle.
  const criticalKeys = useMemo(() => criticalPathKeys(phases), [phases]);

  // The Tender tab shows for a task/sub-task row the viewer may tender, or any
  // row that already has a tender to read. Phases never tender.
  const showTenderTab = isTaskRow && (canStartTender || !!activeRfp);

  // The in-place tendering modal (LINA-420). Holds the task id the overlay is
  // tendering over, or null when closed. "Start tendering" sets it instead of
  // navigating to /plan/procurement, so the owner stays on the plan screen. The
  // overlay mounts <ProcurementSection> scoped to that task.
  const [tenderKey, setTenderKey] = useState<string | null>(null);
  const tenderKeyRef = useRef<string | null>(null);
  tenderKeyRef.current = tenderKey;
  const openTender = useCallback((key: string, section: WorkspaceSection = 'overview') => {
    setWorkspaceSection(section);
    setTenderKey(key);
  }, []);
  const closeTender = useCallback(() => {
    setTenderKey(null);
    // ProcurementSection mirrors its selection into ?rfp=/?compare= via the raw
    // History API; clear them on close so the plan URL does not keep a stale tender
    // selection (the drawer's own ?task= is left untouched).
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      params.delete('rfp');
      params.delete('compare');
      const qs = params.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
  }, []);
  // Resolve the task the overlay is open on to an EXISTING tender (if any), exactly
  // as the standalone procurement page did (LINA-420): an already-tendered task
  // opens on its tender's inbox — responses + Compare — rather than a blank
  // composer, and re-opening "Start tendering" lands there too (the "warn me a
  // tender already exists / let me edit it" ask). A task may root more than one RFP
  // over its life; getMyRfps is newest-first, so the first match is the live one.
  const tenderExistingRfp = useMemo(
    () => (tenderKey ? governingRfp(allRfps, tenderKey, procurementView[tenderKey]?.rfpId) : null),
    [tenderKey, allRfps, procurementView],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Stay on the `/plan` route — the task is a query param, not a sibling path
    // (LINA-404). replaceState feeds Next 15's canonical URL, and every server
    // action revalidates it; a sibling/redirect route there navigated on each
    // save and blanked the page. Compare pathname+search so the query change is
    // seen.
    const next = workspaceKey ? taskHref(projectId, workspaceKey) : planHref(projectId);
    if (window.location.pathname + window.location.search !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [projectId, workspaceKey]);

  // A fresh task means a fresh link — the "Copied" flash must not carry over.
  useEffect(() => { setCopied(false); }, [workspaceKey]);

  const copyLink = useCallback(async () => {
    if (!workspaceKey) return;
    const url = `${window.location.origin}${taskHref(projectId, workspaceKey)}`;
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
  // The drawer's Specialty control reads the SAME catalog the grid does (LINA-404),
  // so the two surfaces offer identical trades and both learn a newly-typed one.
  const { specialties, taxonomy, remember: rememberSpecialty } = useSpecialtyCatalog();

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
  const apply = useCallback((raw: PhaseDraft[]) => {
    // Roll a parent's end out to cover its latest-ending child before anything
    // else (LINA-404, founder's ask): a parent's end is never before a
    // descendant's. Pure and idempotent — a draft that already holds the
    // invariant comes back the same ref, so this never fabricates an edit — and
    // it sits here, on the universal funnel, so EVERY gesture keeps the rule
    // (adding a sub-task, dating one, dragging a bar), not just date edits.
    const next = enforceParentRollup(raw);
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

  // Applying ONE link enforces ONLY that link's dependent — not the whole graph
  // (LINA-306, founder's ask): drawing "1.1 ends with 1.1.1" moves 1.1 alone and
  // leaves every other task where it is, including tasks that transitively follow
  // it. A link is a constraint on its own pair; it does not re-flow the plan.
  const applyLink = useCallback((next: PhaseDraft[], dependent: string) => {
    apply(enforceLink(next, dependent));
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

    // ── v2 write (LINA-369, S3b) ────────────────────────────────────────────────
    // Incremental save through the session-bound server action: hand the
    // last-saved tree (`prev`, null for a fresh build's first save) and the tree
    // now (`stages`); the action diffs and fires the ordered v2 request set. On
    // success, adopt the v2 ids the save minted for any CREATED rows — in the live
    // tree and the last-saved snapshot both — so the next diff targets the stored
    // id and never re-creates a row. Status is NOT set here: on a v2 draft it stays
    // the honest all-grey meter (ADR-0019), and progress is a separate v2 flow.
    if (saveV2) {
      try {
        const prev = lastSavedWireRef.current;
        const res = await saveV2(prev, stages);
        if (!res.ok) {
          setError(res.message
            || 'That did not save. Your edits are still here — they will retry on the next change.');
          setSaveState('error');
          return;
        }
        const idByKey = res.stageIds;
        if (Object.keys(idByKey).length > 0) {
          // Read the LATEST tree (an edit may have landed mid-write): rekey only
          // the rows this save created; rows added since keep their local keys and
          // are created on the next save. The last-saved snapshot is the SENT tree
          // rekeyed — exactly what the server now holds, pending edits excluded.
          const rekeyed = rekeyDraft(phasesRef.current, idByKey);
          phasesRef.current = rekeyed;
          setPhases(rekeyed);
          // The open panel follows its row onto the minted id.
          setOpenKey((k) => (k && idByKey[k] ? idByKey[k] : k));
          lastSavedWireRef.current = rekeyWire(stages, idByKey);
          // A created row's key is now its stable v2 id — record id→id so its
          // status is settable this session without a reload (LINA-404 FIX 1).
          setStageIdByKey((prev) => {
            const next = new Map(prev);
            for (const localKey of Object.keys(idByKey)) {
              const id = idByKey[localKey];
              next.set(id, id);
            }
            return next;
          });
        } else {
          // Nothing created — the tree we sent IS what the server now holds.
          lastSavedWireRef.current = stages;
        }
        // Every row we just SENT now lives on the server (rekeyed to its stored
        // id) — light up its workspace. Rows added since stay "save first".
        setSavedKeys((prevKeys) => {
          const nextKeys = new Set(prevKeys);
          draftKeys(current).forEach((k) => nextKeys.add(idByKey[k] ?? k));
          return nextKeys;
        });
        setSaveState('saved');
        // The page NEVER reloads on a save (LINA-404, founder: edits must land in
        // place). Reorders and reparents are now persisted as their own v2 ops
        // (`reorder_children` / `move_subtree`, plan-diff.ts), so `needsReload` is
        // always false and there is no router.refresh() to throw away the live tree.
        return;
      } finally {
        savingRef.current = false;
        if (pendingRef.current) { pendingRef.current = false; void flushRef.current(); }
      }
    }

    // The v1 whole-tree fallback (authorPlan → POST /api/v1/…:author) was removed
    // in LINA-387 (Phase 12c). Every mount passes `saveV2`, so the block above is
    // the only save path. Reaching here means the editor was mounted without a
    // saver — fail safe by releasing the lock rather than hanging on 'saving'.
    savingRef.current = false;
    pendingRef.current = false;
    setSaveState('error');
    setError('This editor is misconfigured — reload the page to try again.');
  }, [projectId, saveV2]);

  useEffect(() => { flushRef.current = flush; }, [flush]);
  // Flush a still-pending debounce on unmount so the last edit is never lost when
  // the author navigates away right after typing.
  useEffect(() => () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); void flushRef.current(); }
  }, []);

  // Heal stored data once on open (LINA-404). If resuming rolled a parent's end
  // out — its stored end was behind a descendant's (a plan authored before the
  // rule, or a sub-task dated past its parent) — persist that correction so EVERY
  // surface agrees: the read /plan view and record projection read the stored
  // ends, not this editor's in-memory tree, so a display-only fix would leave
  // them showing the stale parent end. `lastSavedWireRef` holds the STORED tree,
  // so the write diffs against storage and sends just the moved end. Gated on a
  // real change (rollup returns the same ref when already consistent), so a
  // healthy plan never writes — no fabricated save, no spurious ledger entry.
  const healedOnMount = useRef(false);
  useEffect(() => {
    if (healedOnMount.current) return;
    healedOnMount.current = true;
    if (!resuming || phasesRef.current === initialPhases) return;  // nothing to heal
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { flushRef.current(); }, 900);
  }, [resuming, initialPhases]);

  // Adding a link snaps its dependent (`nodeKey`) and nothing else; removing one
  // moves nothing (a released stage keeps its last dates). Either way the rest of
  // the plan stays put (LINA-306).
  const toggleDep = useCallback((nodeKey: string, dep: string) => {
    const next = toggleDependency(phases, nodeKey, dep);
    const added = dependsOnOf(next, nodeKey).some((d) => d.on === dep);
    if (added) applyLink(next, nodeKey); else apply(next);
  }, [applyLink, apply, phases]);

  // Re-typing a link is a plan edit like any other — and now re-enforces just the
  // dependent's dates against its new rule (LINA-306): flip starts_after to
  // ends_with and that one bar re-snaps the moment the type changes.
  const retypeDep = useCallback((nodeKey: string, dep: string, type: DepType) => {
    applyLink(setDependencyType(phases, nodeKey, dep, type), nodeKey);
  }, [applyLink, phases]);

  // Clear ONE link — the drawer chip's ✕ and now the unlink control that sits in
  // the middle of the Gantt arrow (LINA-306). toggleDependency removes an existing
  // edge; nothing is re-enforced, so the freed stage — and every other stage —
  // keeps its last dates (no constraint, no move).
  const unlinkDep = useCallback((fromKey: string, toKey: string) => {
    apply(toggleDependency(phases, fromKey, toKey));
  }, [apply, phases]);

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
    // enforceLink is what makes "starts when that one ends" real: the link is
    // created here AND the dependent (fromKey) is snapped to obey it, so a fresh
    // drag-to-link reschedules THAT bar — and only that bar — in the same gesture
    // (LINA-306). Downstream tasks are left alone.
    applyLink(setDependencyType(created, fromKey, toKey, type), fromKey);
    setOpenDeps(null);
  }, [applyLink, phases]);

  const assign = useCallback((nodeKey: string, partyId: string | null) => {
    apply(setAssignee(phases, nodeKey, partyId));
  }, [apply, phases]);

  const retrade = useCallback((nodeKey: string, trade: string, code?: string) => {
    apply(setTrade(phases, nodeKey, trade, code));
  }, [apply, phases]);

  // Set a leaf task's status straight from the draft grid (LINA-307, founder ask
  // "I should always be able to move the status of a task"). Status is NOT part of
  // the authored draft — it is an append-only, attributed progress report — so
  // this does NOT go through the debounced save. Since LINA-384 (Phase 12b.5) it
  // POSTs through the v2 progress endpoint (`/api/v2/tasks/{taskId}/progress`), no
  // longer the retired v1 `/stages/:id/progress`. The v2 TASK id is stable: for a
  // hydrated existing row it IS the node key (v2 ids are keys — planning-hydrate);
  // for a row created this session it is the id the save minted, kept in
  // stageIdByKey. A node with no live id yet (never saved) is read-only in the
  // grid and never reaches here. On success we refresh so the server's derived
  // status — and every parent meter that rolls it up — re-reads.
  // Post ONE append-only progress report, resolving the node key to its live v2
  // id. Throws a typed refusal (role / no active org / out-of-scope) so the grid
  // picker rolls back and shows it inline, as the v1 path surfaced PlanActionError.
  const postProgress = useCallback(async (nodeKey: string, status: StageStatus) => {
    if (!reportProgressV2) return;
    const taskId = stageIdByKey.get(nodeKey) ?? nodeKey;
    const res = await reportProgressV2(taskId, status);
    if (!res.ok) throw new Error(res.message);
  }, [reportProgressV2, stageIdByKey]);

  // Write reported statuses into the draft IN PLACE — no page reload (LINA-404,
  // founder: "the page should never refresh … each change saved atomically"). The
  // old code called `router.refresh()` after every status post, which reloaded the
  // whole plan page AND — because the editor's tree lives in client state whose
  // initialisers never re-run on a refresh — threw the just-set status away on the
  // round trip, the "status not recorded" bug. Patching the draft instead keeps the
  // post atomic: the picker, the parent meter and the drawer all re-read the new
  // value from the same in-memory tree, and a later genuine reload now re-reads it
  // from storage too (the hydration fix carries a reported status on a draft plan).
  const patchStatus = useCallback((updates: Map<string, StageStatus>) => {
    if (updates.size === 0) return;
    const next = applyStatusPatch(phasesRef.current, updates);
    if (next === phasesRef.current) return;
    phasesRef.current = next;
    setPhases(next);
  }, []);

  // Set a row's status (LINA-307 + LINA-404 FIX 1). A LEAF posts its own status;
  // moving a leaf OFF done reopens any ancestor currently `done` to `in_progress`
  // so the tree stays consistent (founder's ask). A PARENT/PHASE moving TO done
  // opens the confirm modal — the cascade runs on confirm, so nothing is posted
  // here (the grid's pickers are leaves and never reach that branch; it fires from
  // the drawer's parent control). On success we PATCH the draft in place so the
  // derived meters re-read with no reload. A refusal throws so the picker rolls back.
  const setStatus = useCallback(async (nodeKey: string, status: StageStatus) => {
    if (!reportProgressV2) return;
    setError(null);
    const loc = locateStatusNode(phasesRef.current, nodeKey);
    if (status === 'done' && loc?.hasChildren) {
      setCascade({ nodeKey, leafKeys: loc.descendantLeaves });
      return;
    }
    await postProgress(nodeKey, status);
    const updates = new Map<string, StageStatus>([[nodeKey, status]]);
    if (status !== 'done' && loc) {
      for (const aKey of loc.ancestors) {
        if (statusOfKey(phasesRef.current, aKey) === 'done') {
          await postProgress(aKey, 'in_progress');
          updates.set(aKey, 'in_progress');
        }
      }
    }
    patchStatus(updates);
  }, [reportProgressV2, postProgress, patchStatus]);

  // Run the parent/phase "mark everything below done" cascade (LINA-404 FIX 1):
  // the parent AND every descendant leaf each get their own attributed `done`
  // progress row, so the audit trail stays honest. Append-only, one call per task,
  // then one in-place patch so the whole subtree re-reads done with no reload.
  const runCascadeDone = useCallback(async () => {
    const c = cascade;
    if (!c) return;
    setCascade(null);
    try {
      await postProgress(c.nodeKey, 'done');
      for (const leafKey of c.leafKeys) await postProgress(leafKey, 'done');
      const updates = new Map<string, StageStatus>([[c.nodeKey, 'done']]);
      for (const leafKey of c.leafKeys) updates.set(leafKey, 'done');
      patchStatus(updates);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not mark the sub-tasks done.');
    }
  }, [cascade, postProgress, patchStatus]);

  // Which leaf rows are settable: those the server holds a live id for. A Set so
  // the grid can test membership per row without re-deriving it.
  const statusSettableKeys = useMemo(() => new Set(stageIdByKey.keys()), [stageIdByKey]);

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

  const rename = useCallback((value: string, path: NodePath) => {
    apply(renameAt(phases, path, value));
  }, [apply, phases]);

  // PRD-13 S-10: a date change on a BASELINED row is not autosaved — it opens the
  // task panel on a "Before you save" note (the server's :preview-move: what it
  // pushes, the new handover, who is told) and lands only on "Save new finish",
  // as one D-26 delta with the optional why (S-11). Other rows edit as before.
  const [pendingMove, setPendingMove] = useState<({ key: string } & PendingMove) | null>(null);
  const interceptBaselined = useCallback((path: NodePath, start: string, end: string): boolean => {
    const node = nodeAtPath(phasesRef.current, path);
    if (!node || !slip?.byTask[node.key]?.baseline || !start || !end) return false;
    setPendingMove({ key: node.key, start, end });
    setOpenKey(node.key);
    setDrawerTab('plan');
    return true;
  }, [slip]);

  const setDate = useCallback((field: 'start' | 'end', value: string, path: NodePath) => {
    const node = nodeAtPath(phasesRef.current, path);
    if (node && 'start' in node) {
      const start = field === 'start' ? value : node.start;
      const end = field === 'end' ? value : node.end;
      if (interceptBaselined(path, start, end)) return;
    }
    applyDeps(setDateAt(phases, path, field, value));
  }, [applyDeps, phases, interceptBaselined]);

  // A Gantt drag or an empty-track click lands here: write the row's start and
  // finish in one op. Same draft, same tested vocabulary the panel's date
  // inputs use — the timeline just computes the dates from a pointer.
  const setDates = useCallback((path: NodePath, start: string, end: string) => {
    if (interceptBaselined(path, start, end)) return;
    applyDeps(setDatesAt(phases, path, start, end));
  }, [applyDeps, phases, interceptBaselined]);

  // PRD-13 S-15: the "Changes since baseline" panel shares the docked slot with
  // the task panel — opening one closes the other.
  const router = useRouter();
  const [changesOpen, setChangesOpen] = useState(false);
  const outlineOf = useCallback((id: string) => index.get(id)?.outline ?? null, [index]);
  const openChanges = useCallback(() => { setOpenKey(null); setChangesOpen(true); }, []);
  const refreshSlip = useCallback(() => { router.refresh(); }, [router]);
  // A server write that moved dates (a new finish, a close): flush any pending
  // autosave first, then reload so the draft and the bars read the stored plan.
  const reloadAfterServerWrite = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; void flushRef.current(); }
    setTimeout(() => { window.location.reload(); }, 400);
  }, []);

  // Add a child under any row (a task under a phase, a sub-task under a task, to
  // MAX_DEPTH) and hand back its key so the grid opens rename on it.
  const addChild = useCallback((parentPath: NodePath): string => {
    const next = addChildAt(phases, parentPath);
    if (next === phases) return '';
    apply(next);
    const parent = nodeAtPath(next, parentPath);
    const list = parent ? ('tasks' in parent ? parent.tasks : parent.children) : [];
    return list[list.length - 1]?.key ?? '';
  }, [apply, phases]);

  // Close the panel on Escape — there is no scrim to click any more (P-1).
  useEffect(() => {
    if (!openRow) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !tenderKeyRef.current) { setOpenRow(null); setOpenDeps(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openRow]);

  // Drag a SUMMARY bar to move the whole group (LINA-404, founder's ask: "if I move
  // the parent task, the tasks inside move with it"). `shiftGroup` slides the named
  // stage and every descendant by the same whole-day delta; the parent's derived
  // envelope follows, and applyDeps re-flows anything linked to it — exactly the
  // leaf-drag pipeline, fed a rigid group move. The grid sends the TOTAL offset from
  // the drag start, applied against the tree snapshotted when the drag began — so it
  // is ABSOLUTE and idempotent (a dropped render never double-counts), like the leaf
  // drag's absolute dates. The move stream collapses into one debounced save.
  const groupBaseRef = useRef<{ key: string; tree: PhaseDraft[] } | null>(null);
  const shiftGroupDates = useCallback((key: string, deltaDays: number) => {
    if (!groupBaseRef.current || groupBaseRef.current.key !== key) {
      groupBaseRef.current = { key, tree: phasesRef.current };
    }
    applyDeps(shiftGroup(groupBaseRef.current.tree, key, deltaDays));
  }, [applyDeps]);
  const endGroupShift = useCallback(() => { groupBaseRef.current = null; }, []);

  // The docked panel's derived bits (PRD-01 P-1/P-2). `panelOpen` guards a
  // stale key (a removed row) so nothing renders half a panel.
  const panelOpen = openRow != null && activePhase != null && (!isTaskRow || active != null);
  const panelWhat = !isTaskRow ? 'Phase details' : isSubRow ? 'Sub-task details' : 'Task details';
  // The bridge's window when it has one; else the bare RFP status from the list
  // (a tender whose lanes read failed still says what state it is in).
  const activeProc: ProcurementRfp | undefined = (activeKey ? procurementView[activeKey] : undefined)
    ?? (activeRfp
      ? { status: activeRfp.status, openedDay: '', bidsDueDay: '', submittedCount: 0, title: activeRfp.title }
      : undefined);
  const activeChip = procurementChip(activeProc);
  // Composing and comparing want room (B2/B4): the Tender tab widens to 640px.
  const panelWide = drawerTab === 'tender' && (panelFace === 'compose' || panelFace === 'compare');

  return (
    <main className={`pbx pbx--grid${panelOpen ? (panelWide ? ' has-panel is-wide' : ' has-panel') : changesOpen ? ' has-panel' : ''}`}>
      <header className="pbx-head">
        <div>
          <p className="pbx-eyebrow">{resuming ? 'Your draft' : 'New plan'}</p>
          <h1 className="pbx-title">Build the plan directly in LinkNMS</h1>
          <p className="pbx-lede">
            Compose phases and tasks, assign an accountable specialty and owner, and set the dates
            by clicking and dragging the bars — or leave what you don’t know blank.{' '}
            {v2
              ? 'Your changes save automatically to this build’s plan.'
              : 'Saving keeps this as your private draft — only you can see it, and nothing is sent until you choose to send it for approval.'}
          </p>
        </div>
        {v2
          ? <span className="pbx-draft">Saves automatically</span>
          : <span className="pbx-draft">Draft — only you can see it</span>}
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
              : saveState === 'saved' ? (v2 ? 'All changes saved' : 'All changes saved · draft only you can see')
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
          {procurementHref ? (
            <Link className="pbx-icon" href={procurementHref}
              title="Put part of the plan out to tender and compare the bids"
              style={{ width: 'auto', padding: '0 10px', display: 'inline-flex', alignItems: 'center' }}>
              Tendering
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
      {/* PRD-13 S-6: the handover and the door to "Changes since baseline". */}
      <SlipHeader slip={slip} onOpenChanges={openChanges} />

      <PlanGrid
        phases={phases}
        parties={parties}
        litRows={litRows}
        disabled={false}
        todayIso={todayIso}
        slip={slip}
        onOpenRow={(path) => { setChangesOpen(false); setOpenRow([...path]); }}
        activeKey={activeKey ?? null}
        onRename={rename}
        onSetDate={setDate}
        onDates={setDates}
        onShiftGroup={shiftGroupDates}
        onShiftGroupEnd={endGroupShift}
        onAssign={assign}
        onTrade={retrade}
        onAddPhase={() => {
          const next = addPhase(phases);
          apply(next);
          return next[next.length - 1].key;
        }}
        onAddChild={addChild}
        onRemove={(path) => {
          // Removing the open row (or an ancestor of it) closes the panel rather
          // than leaving it pointed at a path that now names a different row.
          if (openRow && path.every((v, i) => openRow[i] === v)) setOpenKey(null);
          apply(removeAt(phases, path));
        }}
        onReorder={(parentPath, from, to) => apply(reorderAt(phases, parentPath, from, to))}
        onPromote={(path) => apply(promoteAt(phases, path))}
        onDemote={(path) => apply(demoteAt(phases, path))}
        onLinkDep={linkDep}
        onUnlinkDep={unlinkDep}
        onSetStatus={setStatus}
        statusSettableKeys={statusSettableKeys}
        onStartTender={canStartTender ? (key) => {
          // PRD-02: tendering starts in the row's panel, on the Tender tab.
          const path = pathOfKey(phases, key);
          if (!path) return;
          // A phase never tenders: its panel opens on Plan as usual.
          const tab = index.get(key)?.isPhase ? null : 'tender';
          pendingTabRef.current = tab;
          setChangesOpen(false);
          setOpenRow([...path]);
          if (activeKey === key && tab) setDrawerTab(tab);
        } : undefined}
        // Only server-persisted rows can be tendered — the composer pre-selects a
        // real task id, so a not-yet-saved row offers no "Start tendering" link.
        // The kind (design vs execution) is the owner's choice in the composer
        // (LINA-420), so the deep-link no longer pins a mode.
        tenderableKeys={saved}
        procurement={procurementView}
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

      {/* No Save, no Cancel (founder, LINA-306): every edit autosaves. On v2 the
          save writes the build's live plan; the v1 "send for approval" step is a
          separate v2 slice (S6), so the link goes to the record, not a proposal. */}
      <div className="pbx-actions">
        {v2
          ? <Link className="btn" href={`/projects/${projectId}/record`}>Open the record →</Link>
          : <Link className="btn" href={`/projects/${projectId}/plan`}>View plan &amp; send for approval →</Link>}
      </div>

      {v2 ? (
        <p className="pbx-foot">
          Your changes save automatically to this build’s plan, and each save records one attributed
          event on the shared record. Requesting sign-off is a separate step that arrives with the
          v2 record.
        </p>
      ) : (
        <p className="pbx-foot">
          Your changes save automatically as a private draft — only you can see them, and each save
          records one event on the shared record that the draft was saved. Nothing is sent to the other
          party and no approval is requested until you choose <strong>Send for approval</strong> on the
          plan page.
        </p>
      )}

      {changesOpen && !panelOpen && slip ? (
        <ChangesPanel
          projectId={projectId}
          slip={slip}
          outlineOf={outlineOf}
          onClose={() => setChangesOpen(false)}
          onOpenTask={(taskId) => { setChangesOpen(false); setOpenKey(taskId); setDrawerTab('plan'); }}
          onChanged={refreshSlip}
        />
      ) : null}

      {panelOpen && openRow && activePhase ? (
        // The DOCKED task panel (PRD-01 P-1): no scrim, no dimming — the grid
        // beside it stays live, and clicking another row switches the panel.
        // Escape or ✕ closes it. 480px; 640px (`is-wide`) when the Tender tab
        // has bids to compare.
        <aside
          className={`pbx-drawer pbx-panel${panelWide ? ' is-wide' : ''}`}
          role="complementary"
          aria-label={panelWhat}
        >
            <header className="pbx-drawer-hd">
              <div>
                <p className="pbx-drawer-eyebrow">
                  {panelWhat}
                  {isTaskRow ? <span className="pbx-drawer-outline"> · {index.get(activeKey ?? '')?.outline}</span> : null}
                </p>
                <h2 className="pbx-drawer-title">
                  {(isTaskRow ? active!.name : activePhase.name).trim()
                    || (!isTaskRow ? 'Untitled phase' : isSubRow ? 'Untitled sub-task' : 'Untitled task')}
                </h2>
                {isSubRow && activeParent ? (
                  <p className="pbx-drawer-under">
                    Under {activeParent.name.trim() || 'an untitled task'}
                  </p>
                ) : null}
                {/* The tender's lifecycle, said once at the top (LINA-420) — in the
                    SAME lifecycle colour and words as the grid chip (PRD-01 G-8). */}
                {activeChip ? (
                  <span className={`pgd-tenderchip is-${activeChip.state.replace('_', '-')} pbx-drawer-chip`}>
                    {activeChip.label}
                  </span>
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

            {/* The panel's four tabs (PRD-01 P-2): Plan · Tender · Conversation ·
                Files. Each label carries its state: Tender none / draft / n/m /
                n in / awarded; Files its count. Tender shows for a task row that
                has, or may have, a tender; Conversation and Files for any task. */}
            <div className="pbx-drawer-tabs" role="tablist" aria-label="Task detail sections">
              <button
                type="button" role="tab" id="pbx-tab-plan"
                className={`pbx-drawer-tab${drawerTab === 'plan' ? ' is-active' : ''}`}
                aria-selected={drawerTab === 'plan'}
                onClick={() => setDrawerTab('plan')}
              >Plan</button>
              {showTenderTab ? (
                <button
                  type="button" role="tab" id="pbx-tab-tender"
                  className={`pbx-drawer-tab${drawerTab === 'tender' ? ' is-active' : ''}`}
                  aria-selected={drawerTab === 'tender'}
                  onClick={() => setDrawerTab('tender')}
                >
                  Tender
                  <span className={`pbx-drawer-tabcount${activeChip ? ` is-${activeChip.state.replace('_', '-')}` : ''}`}>
                    {procurementTabLabel(activeProc)}
                  </span>
                  {activeProc?.openQuestions ? (
                    <span className="tnd-tab-q" title={`${activeProc.openQuestions} open questions from bidders`}
                      aria-label={`${activeProc.openQuestions} open questions from bidders`}>
                      {activeProc.openQuestions}
                    </span>
                  ) : null}
                </button>
              ) : null}
              {isTaskRow ? (
                <button
                  type="button" role="tab" id="pbx-tab-conversation"
                  className={`pbx-drawer-tab${drawerTab === 'conversation' ? ' is-active' : ''}`}
                  aria-selected={drawerTab === 'conversation'}
                  onClick={() => setDrawerTab('conversation')}
                >Conversation</button>
              ) : null}
              {isTaskRow ? (
                <button
                  type="button" role="tab" id="pbx-tab-files"
                  className={`pbx-drawer-tab${drawerTab === 'files' ? ' is-active' : ''}`}
                  aria-selected={drawerTab === 'files'}
                  onClick={() => setDrawerTab('files')}
                >
                  Files
                  {fileTabLabel != null ? (
                    <span className={`pbx-drawer-tabcount${filesSummary?.toReview ? ' is-bids-in' : ''}`}>{fileTabLabel}</span>
                  ) : null}
                </button>
              ) : null}
            </div>

            {drawerTab === 'plan' ? (
            <>
            {/* Status is an append-only, attributed progress report (LINA-307,
                LINA-404 FIX 1). A LEAF gets a live picker; a PARENT/PHASE gets the
                "mark everything below done" cascade (a confirm modal fans it out to
                every sub-task). A never-saved row has no live id yet, so it stays a
                read-only chip until the next autosave lands. The derived parent
                METER stays honest (ADR-0019) — this sets leaf status, not the meter. */}
            {(() => {
              const statusKey = activeKey ?? null;
              const settable = !!statusKey && statusSettableKeys.has(statusKey);
              const isPhase = !isTaskRow;
              const isParent = isPhase
                ? (activePhase?.tasks.length ?? 0) > 0
                : (active?.children ?? []).length > 0;
              const isLeaf = !!active && !isParent;
              return (
                <div className="pbx-drawer-status">
                  {settable && isParent ? (
                    <>
                      <button
                        type="button" className="pbx-icon" style={{ width: 'auto', padding: '0 10px' }}
                        title={`Report “done” for this ${isPhase ? 'phase' : 'task'} and every sub-task under it`}
                        onClick={() => { void setStatus(statusKey!, 'done'); }}
                      >Mark everything below done</button>
                      <span className="pbx-status-hint">
                        Marks this {isPhase ? 'phase' : 'task'} and each of its sub-tasks done — you’ll confirm first.
                      </span>
                    </>
                  ) : settable && isLeaf ? (
                    <>
                      <StatusPicker
                        key={`${statusKey}:${nodeStatus(active!)}`}
                        nodeKey={statusKey!}
                        value={nodeStatus(active!)}
                        over={false}
                        what={isSubRow ? 'Sub-task' : 'Task'}
                        onSet={setStatus}
                        blockDone={filesSummary?.doneBlocked
                          ? 'Every required deliverable must be approved before this task is done — see Files.' : null}
                      />
                      <span className="pbx-status-hint">
                        {filesSummary?.doneBlocked
                          ? 'Done unlocks once every required deliverable is approved (Files tab).'
                          : 'Records one attributed progress report on the shared record.'}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="pbx-status-chip">Not started</span>
                      <span className="pbx-status-hint">
                        Status can be reported once this row is saved to the plan.
                      </span>
                    </>
                  )}
                </div>
              );
            })()}

            <div className="pbx-drawer-meta">
              {/* Owner / Specialty now reuse the SAME Jira-style dropdown the grid
                  rows use (LINA-404) — the drawer's old full-width <select>/<input>
                  stretched the panel; these size to their content. */}
              <span className="pbx-drawer-label">Owner</span>
              <OwnerField
                value={(isTaskRow ? active!.assigneePartyId : activePhase.assigneePartyId) ?? null}
                parties={parties}
                dir={dir}
                disabled={parties.length === 0 || !activeKey}
                ariaLabel="Owner"
                onAssign={(partyId) => activeKey && assign(activeKey, partyId)}
                variant="full"
              />

              <span className="pbx-drawer-label">Specialty</span>
              <SpecialtyField
                value={isTaskRow ? active!.trade : activePhase.trade}
                options={specialties}
                taxonomy={taxonomy}
                disabled={!activeKey}
                ariaLabel="Specialty (trade)"
                onSet={(label, code) => activeKey && retrade(activeKey, label, code)}
                onRemember={rememberSpecialty}
              />

              {isTaskRow && active ? (
                // A summary task (one with sub-tasks) derives its dates from its
                // children (LINA-404), so its date fields are read-only here too.
                (() => {
                  const derived = (active.children ?? []).length > 0;
                  return (
                    <>
                      <span className="pbx-drawer-label">Start</span>
                      <input
                        type="date" className="pbx-date" value={active.start}
                        aria-label="Start date" disabled={derived}
                        title={derived ? 'Derived from the sub-tasks' : undefined}
                        onChange={(e) => setDate('start', e.target.value, openRow)}
                      />
                      <span className="pbx-drawer-label">Finish</span>
                      <input
                        type="date" className="pbx-date" value={active.end}
                        aria-label="Finish date" disabled={derived}
                        title={derived ? 'Derived from the sub-tasks' : undefined}
                        onChange={(e) => setDate('end', e.target.value, openRow)}
                      />
                    </>
                  );
                })()
              ) : null}

              {/* P-3: the Schedule row — whether this row drives the build's finish. */}
              {activeKey ? (
                <>
                  <span className="pbx-drawer-label">Schedule</span>
                  <span className={`pbx-drawer-sched${criticalKeys.has(activeKey) ? ' is-critical' : ''}`}>
                    {criticalKeys.has(activeKey) ? '◆ Critical path' : 'Not on the critical path'}
                  </span>
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

            {/* PRD-13: Baseline vs Now, the overdue prompt, a new finish with its
                impact note before saving, and the changes on this task. */}
            {isTaskRow && active && activeKey && slip?.byTask[activeKey]
              && (slip.byTask[activeKey].baseline || slip.byTask[activeKey].overrunWd || slip.byTask[activeKey].projected
                || pendingMove?.key === activeKey) ? (
              <TaskSlipSection
                key={activeKey}
                projectId={projectId}
                slip={slip.byTask[activeKey]}
                outlineOf={outlineOf}
                isLeaf={(active.children ?? []).length === 0}
                pending={pendingMove?.key === activeKey ? { start: pendingMove.start, end: pendingMove.end } : null}
                onClearPending={() => setPendingMove(null)}
                onCommitted={reloadAfterServerWrite}
                onChanged={refreshSlip}
              />
            ) : null}

            {isTaskRow && active ? (
              <>
                <label className="pbx-drawer-label" htmlFor="pbx-task-desc">Description</label>
                <textarea
                  id="pbx-task-desc"
                  className="pbx-drawer-desc"
                  value={active.description}
                  placeholder="What is this task? Add scope, context, anything the other party should know."
                  maxLength={4000}
                  disabled={false}
                  onChange={(e) => apply(setDescriptionAt(phases, openRow, e.target.value))}
                />
              </>
            ) : (
              <p className="pbx-status-hint">
                A phase’s dates are read off its tasks — schedule those and the phase bar follows.
              </p>
            )}

            {/* P-3: the Breakdown block — how much hangs under this row, and the
                way to add the next level (never past MAX_DEPTH). */}
            {(() => {
              const node = isTaskRow ? active : activePhase;
              if (!node) return null;
              const b = breakdownOf(node);
              const childWord = isTaskRow ? 'sub-task' : 'task';
              return (
                <div className="pbx-drawer-breakdown">
                  <span className="pbx-drawer-label">Breakdown</span>
                  <span className="pbx-status-hint">
                    {b.count === 0
                      ? `No ${childWord}s yet.`
                      : `${b.count} ${b.count === 1 ? childWord : `${childWord}s`} across ${b.levels} ${b.levels === 1 ? 'level' : 'levels'}`}
                  </span>
                  {canAddChildAt(openRow) ? (
                    <button
                      type="button" className="pgd-add"
                      onClick={() => { addChild(openRow); }}
                    >＋ Add {childWord}</button>
                  ) : (
                    <span className="pbx-status-hint">This is the deepest level the plan holds.</span>
                  )}
                </div>
              );
            })()}
            </>
            ) : null}

            {/* The Tender tab (LINA-420): the per-task tender summary — lifecycle
                wizard, key dates, critical-path warning, bidders and proposals.
                Deep actions (invite / compare / award) open the in-place modal,
                which owns those writes; this tab never forks that logic. */}
            {drawerTab === 'tender' && showTenderTab && activeKey ? (
              <TenderPanel
                projectId={projectId}
                taskId={workspaceTaskId ?? activeKey}
                taskName={(active?.name ?? activePhase.name).trim() || 'this task'}
                rfp={activeRfp}
                tasks={tenderTasks}
                canIssue={canStartTender}
                saved={!!workspaceKey}
                todayIso={todayIso}
                onRfpChanged={onPanelRfp}
                onOpenWorkspace={(section) => { if (workspaceKey) openTender(workspaceKey, section); }}
                onFaceChange={setPanelFace}
                openQuestions={activeProc?.openQuestions ?? 0}
                specialtyCode={(active ?? activePhase).tradeCode || null}
                specialtyName={(active ?? activePhase).trade || null}
              />
            ) : null}

            {/* Conversation (the thread) and Files (the task's files) are two
                faces of ONE workspace read (LINA-250/399): it stays mounted for
                any open task so the Files label can carry its count, and shows
                the section the active tab names. `workspaceKey` is null until the
                plan holds this row — the section then says so. */}
            {isTaskRow ? (
              <TaskWorkspace
                taskId={workspaceTaskId}
                parties={parties}
                section={drawerTab === 'conversation' ? 'conversation' : 'none'}
              />
            ) : null}
            {/* Files (PRD-05): Deliverables + Reference, separate from the
                conversation (F-5). Mounted for any open task so the tab label and
                the done gate know the state before the tab is opened. */}
            {isTaskRow ? (
              <TaskFiles
                projectId={projectId}
                taskId={workspaceTaskId}
                taskName={(active?.name ?? '').trim() || 'this task'}
                hasSubtasks={(active?.children ?? []).length > 0}
                visible={drawerTab === 'files'}
                taskNameOf={(id) => taskNames.get(id) ?? null}
                orgNameOf={(id) => (id ? dir.get(id)?.name ?? null : null)}
                onSummary={setFilesSummary}
              />
            ) : null}

            <div className="pbx-drawer-actions">
              <button type="button" className="btn primary"
                onClick={() => { setOpenRow(null); setOpenDeps(null); }}>Done</button>
            </div>
        </aside>
      ) : null}

      {/* The "mark everything below done" confirm (LINA-404 FIX 1). Self-contained
          overlay (inline styles) so it never depends on drawer layout — a plain
          centered dialog with a working-day-honest count of what it will mark. */}
      {cascade ? (
        <div
          className="pbx-drawer-scrim" role="presentation"
          onClick={() => setCascade(null)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            role="dialog" aria-modal="true" aria-label="Mark sub-tasks done"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface, #fff)', color: 'inherit', maxWidth: 440, width: '90%',
              padding: '20px 22px', borderRadius: 12, boxShadow: '0 12px 48px rgba(0,0,0,.28)',
            }}
          >
            <h2 className="pbx-drawer-title" style={{ marginTop: 0 }}>Mark the sub-tasks done too?</h2>
            <p style={{ margin: '8px 0 18px' }}>
              {cascade.leafKeys.length === 0
                ? 'This reports this row as done.'
                : `This reports done for this row and its ${cascade.leafKeys.length} `
                  + `${cascade.leafKeys.length === 1 ? 'sub-task' : 'sub-tasks'} — each recorded as its own event.`}
            </p>
            <div className="pbx-drawer-actions">
              <button
                type="button" className="pbx-icon" style={{ width: 'auto', padding: '0 12px' }}
                onClick={() => setCascade(null)}
              >Cancel</button>
              <button type="button" className="btn primary" onClick={() => { void runCascadeDone(); }}>
                Mark all done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* The in-place tendering modal (LINA-420). A full-height overlay over the
          plan — the owner never leaves the plan screen. It mounts the SAME
          <ProcurementSection> (the tendering pages at /tendering mount the same workspace), scoped to
          the task the drawer/row acted on: an already-tendered task opens on its
          tender (responses + Compare, edit / add docs); a fresh one opens the
          composer pre-picked on that task. ProcurementSection owns its own
          ?rfp=/?compare= via the History API, so this does not navigate. */}
      {tenderKey ? (
        <div
          className="pbx-tender-overlay"
          role="presentation"
          onClick={closeTender}
        >
          <aside
            className="pbx-tender-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Tendering"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="pbx-tender-modal-hd">
              <h2 className="pbx-tender-modal-title">Tendering</h2>
              <div className="pbx-tender-modal-hdtools">
                {procurementHref ? (
                  <Link
                    className="pbx-icon"
                    href={tenderExistingRfp
                      ? `${procurementHref}/rfps/${encodeURIComponent(tenderExistingRfp.id)}`
                      : `${procurementHref}/rfps/new?task=${encodeURIComponent(tenderKey)}`}
                    style={{ width: 'auto', padding: '0 10px', display: 'inline-flex', alignItems: 'center' }}
                    title="Open the full tendering page"
                  >
                    Open full page
                  </Link>
                ) : null}
                <button
                  type="button"
                  className="pbx-icon"
                  title="Close"
                  aria-label="Close tendering"
                  onClick={closeTender}
                >✕</button>
              </div>
            </header>
            <div className="pbx-tender-modal-body">
              <ProcurementSection
                projectId={projectId}
                tasks={tenderTasks}
                hasActiveOrg={tenderHasActiveOrg}
                initialMyRfps={allRfps}
                composeTaskId={tenderExistingRfp ? null : tenderKey}
                openRfpId={tenderExistingRfp?.id ?? null}
                composeMode="detailed"
                initialSection={workspaceSection}
                onRfpChanged={(rfp) => onPanelRfp(rfp, {})}
              />
            </div>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
