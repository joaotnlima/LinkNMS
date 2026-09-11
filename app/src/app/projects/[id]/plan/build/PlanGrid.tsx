'use client';

// The unified plan grid (LINA-248) — the ONE face of the "Build the plan"
// editor. The List/Timeline toggle is gone: every row is an editable table row
// on the left (id · name · specialty · owner · dates) AND a timeline track on
// the right, aligned row-for-row, so composing the plan and scheduling it are
// the same gesture on the same screen (pen: "Build the plan — schedule
// (Gantt)"). Follow-ups (2026-09-11): the toolbar picks the timeline's TIME
// BASE (fit / week / month / quarter / 6 months / year / custom start–end),
// the name / specialty / dates columns RESIZE by dragging the header edges,
// and start–finish read as one Dates column.
//
// WHAT A ROW DOES (the founder's four asks, LINA-248):
//   1. OWNER is a column: an avatar — the unassigned ring when nobody owns the
//      stage — with the member <select> laid over it, so clicking the circle
//      opens the dropdown of everyone invited to this build. Same picker
//      discipline as before: project members only, assigning grants nothing.
//   2. SPECIALTY (trade) is a column on the same row; the name cell yields the
//      width.
//   3. The TIMELINE is always visible. A row with no dates is scheduled by
//      CLICKING its empty track: the bar lands on the clicked day, one week
//      long, and is then dragged wherever the author sees fit (move / resize —
//      LINA-236 math, untouched). An undated plan still gets a canvas: the
//      window falls back to today (scheduleWindow).
//   4. CLICKING THE ROW opens the detail drawer (the editor owns it). The name
//      is text, not a permanent input — the ✎ button, sitting RIGHT BESIDE the
//      name (founder follow-up, 2026-09-11), is the one way to rename in place,
//      so a click on the row is never a rename by accident. While the input is
//      open a ✓ button beside it commits the name (Enter and clicking away
//      commit too — the ✓ is the visible affordance).
//   5. ADDING a phase/task/sub-task drops the new row straight into rename mode
//      with the input focused (founder follow-up): the add callbacks return the
//      fresh node's key and the grid opens the editor on it.
//
// This component owns no draft state — every edit calls back into the editor's
// pure ops (@/lib/plan-authoring), exactly as the old list and Gantt did.
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  addDays, applyDrag, baseWindow, clickDates, clipBarGeom, formatDay, parseDay,
  type DragMode, type GanttWindow, type TimeBase,
} from '@/lib/plan-gantt';
import type { PhaseDraft, TaskDraft } from '@/lib/plan-authoring';
import { PartyAvatar, UnassignedAvatar } from '@/components/PartyAvatar';
import { partyIndex, partyOf, roleWord, type PartyRef } from '@/lib/party-display';

// Pixels per day column, per time base (LINA-248 follow-up): the base the
// author picks is a READING scale, so a week spreads its 7 days wide while a
// year compresses to a page-ish sweep. 'custom' is sized after the window is
// known (fit ~1120px, clamped so a day is never ungrabbable-thin).
const BASE_PX: Record<Exclude<TimeBase, 'custom'>, number> = {
  auto: 30, week: 64, month: 30, quarter: 12, half: 6, year: 3,
};
const BASE_LABELS: Array<[TimeBase, string]> = [
  ['auto', 'Fit plan'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'],
  ['half', '6 months'], ['year', 'Year'], ['custom', 'Custom range'],
];
/** Row heights, shared by the table cell and its track so the panes align. */
const H = { phase: 36, task: 42, sub: 36, add: 34 } as const;
const AXIS_H = 28;
/** Resizable columns' minimum widths — below these the cell content breaks. */
const COL_MIN = { name: 120, trade: 56, dates: 150 } as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' → "Mar 9" without touching Date (no timezone surprises). */
function dayLabel(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** 'YYYY-MM-DD' → weekday 0..6 (Mon=0) for the week-boundary axis ticks. */
function weekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Sun=0 → Mon=0
}

/** A phase's derived envelope: earliest start → latest finish of its stages. */
function phaseEnvelope(p: PhaseDraft): { start: string; end: string } | null {
  let lo: number | null = null;
  let hi: number | null = null;
  const eat = (iso: string) => {
    const ms = parseDay(iso);
    if (ms === null) return;
    lo = lo === null || ms < lo ? ms : lo;
    hi = hi === null || ms > hi ? ms : hi;
  };
  p.tasks.forEach((t) => {
    eat(t.start); eat(t.end);
    (t.children ?? []).forEach((s) => { eat(s.start); eat(s.end); });
  });
  if (lo === null || hi === null) return null;
  return { start: formatDay(lo), end: formatDay(hi) };
}

type Row =
  | { kind: 'phase'; pi: number; key: string; phase: PhaseDraft }
  | { kind: 'task'; pi: number; ti: number; si?: number; key: string; node: TaskDraft }
  | { kind: 'add'; pi: number };

export interface PlanGridProps {
  phases: PhaseDraft[];
  parties: PartyRef[];
  /** Stage keys the cycle check named — their rows are outlined. */
  litRows: Set<string>;
  disabled: boolean;
  /** Today as 'YYYY-MM-DD' — anchors the fallback window for undated plans. */
  todayIso: string;
  /** Open the detail drawer for a phase (ti undefined), task or sub-task. */
  onOpenRow: (pi: number, ti?: number, si?: number) => void;
  onRename: (value: string, pi: number, ti?: number, si?: number) => void;
  onSetDate: (field: 'start' | 'end', value: string, pi: number, ti: number, si?: number) => void;
  /** Both dates at once — a drag result or an empty-track click plant. */
  onDates: (pi: number, ti: number, start: string, end: string, si?: number) => void;
  onAssign: (nodeKey: string, partyId: string | null) => void;
  onTrade: (nodeKey: string, trade: string) => void;
  /** Add ops return the NEW node's key so the grid can open rename on it. */
  onAddPhase: () => string;
  onAddTask: (pi: number) => string;
  onAddSubtask: (pi: number, ti: number) => string;
  onRemovePhase: (pi: number) => void;
  onRemoveTask: (pi: number, ti: number) => void;
  onRemoveSubtask: (pi: number, ti: number, si: number) => void;
  onReorderPhase: (from: number, to: number) => void;
  onReorderTask: (pi: number, from: number, to: number) => void;
  onReorderSubtask: (pi: number, ti: number, from: number, to: number) => void;
}

export function PlanGrid(props: PlanGridProps) {
  const { phases, parties, litRows, disabled, todayIso } = props;
  const dir = useMemo(() => partyIndex(parties), [parties]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    phases.forEach((p, pi) => {
      out.push({ kind: 'phase', pi, key: p.key, phase: p });
      p.tasks.forEach((t, ti) => {
        out.push({ kind: 'task', pi, ti, key: t.key, node: t });
        (t.children ?? []).forEach((s, si) =>
          out.push({ kind: 'task', pi, ti, si, key: s.key, node: s }));
      });
      out.push({ kind: 'add', pi });
    });
    return out;
  }, [phases]);

  // ── The time base (founder follow-up, 2026-09-11): the author picks the
  // reading scale — fit / week / month / quarter / 6 months / year — or types
  // the exact start–end window they want. Session-local view state only.
  const [base, setBase] = useState<TimeBase>('auto');
  const [customRange, setCustomRange] = useState<{ from: string; to: string }>({ from: '', to: '' });

  // The window spans the picked base; 'auto' fits every dated stage, and an
  // undated plan still gets a canvas anchored on today so a first bar can be
  // clicked into being (LINA-248).
  const win = useMemo(() => {
    const dated: Array<{ start: string; end: string }> = [];
    rows.forEach((r) => { if (r.kind === 'task') dated.push({ start: r.node.start, end: r.node.end }); });
    return baseWindow(base, dated, todayIso, customRange);
  }, [rows, todayIso, base, customRange]);

  // Day-column width follows the base; a custom window sizes itself to read at
  // roughly one screen, never thinner than a grabbable 3px day.
  const col = base === 'custom'
    ? (win ? Math.max(3, Math.min(30, Math.floor(1120 / win.days))) : 30)
    : BASE_PX[base];

  const onPickBase = useCallback((next: TimeBase) => {
    // Entering custom seeds the inputs with the window currently on screen, so
    // the author edits a sensible range instead of typing from blank.
    if (next === 'custom' && win && !(parseDay(customRange.from) !== null && parseDay(customRange.to) !== null)) {
      setCustomRange({ from: win.startDay, to: win.endDay });
    }
    setBase(next);
  }, [win, customRange]);

  // ── Column resize (founder follow-up): dragging a header edge widens the
  // name / specialty / dates column; widths land as CSS vars on the root. ──
  const [colW, setColW] = useState<{ name?: number; trade?: number; dates?: number }>({});
  const rs = useRef<null | { col: keyof typeof COL_MIN; startX: number; startW: number }>(null);

  const onResizeDown = useCallback((c: keyof typeof COL_MIN) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cell = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    rs.current = { col: c, startX: e.clientX, startW: cell.getBoundingClientRect().width };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);
  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const r = rs.current;
    if (!r) return;
    const w = Math.min(560, Math.max(COL_MIN[r.col], Math.round(r.startW + e.clientX - r.startX)));
    setColW((prev) => (prev[r.col] === w ? prev : { ...prev, [r.col]: w }));
  }, []);
  const onResizeUp = useCallback((e: React.PointerEvent) => {
    if (!rs.current) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    rs.current = null;
  }, []);

  // ── Rename-in-place (ask 4): the ✎ button, and only it, opens the input. ──
  const [editing, setEditing] = useState<string | null>(null);

  // ── Grip drag-to-reorder — same scoping as the old list view. ─────────────
  const [dragPhase, setDragPhase] = useState<number | null>(null);
  const [dragTask, setDragTask] = useState<{ pi: number; ti: number } | null>(null);
  const [dragSub, setDragSub] = useState<{ pi: number; ti: number; si: number } | null>(null);

  // ── Bar drag (LINA-236/244, unchanged): origin captured at pointer-down. ──
  const drag = useRef<
    null | { pi: number; ti: number; si?: number; mode: DragMode; startX: number; start: string; end: string }
  >(null);

  const onBarDown = useCallback((
    e: React.PointerEvent, r: Extract<Row, { kind: 'task' }>, mode: DragMode,
  ) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      pi: r.pi, ti: r.ti, si: r.si, mode,
      startX: e.clientX, start: r.node.start, end: r.node.end,
    };
  }, [disabled]);

  const onBarMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = applyDrag(d.mode, d.start, d.end, e.clientX - d.startX, col);
    props.onDates(d.pi, d.ti, next.start, next.end, d.si);
  }, [props, col]);

  const onBarUp = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    drag.current = null;
  }, []);

  // A click on an UNDATED row's empty track plants a one-week bar on the
  // clicked day (ask 3). A dated row's empty track does nothing — rescheduling
  // an existing bar is a deliberate drag, never a stray click.
  const onTrackClick = useCallback((
    e: React.MouseEvent, w: GanttWindow, r: Extract<Row, { kind: 'task' }>,
  ) => {
    if (disabled || r.node.start || r.node.end) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const d = clickDates(w, x / col);
    props.onDates(r.pi, r.ti, d.start, d.end, r.si);
  }, [disabled, props, col]);

  // Row click opens the drawer — unless the click landed on a control.
  const onRowClick = useCallback((e: React.MouseEvent, r: Row) => {
    if (r.kind === 'add') return;
    if ((e.target as HTMLElement).closest('input, select, button, label, a')) return;
    props.onOpenRow(r.pi, r.kind === 'task' ? r.ti : undefined, r.kind === 'task' ? r.si : undefined);
  }, [props]);

  // Wide day columns tick weekly ("Mar 9"); compressed bases (quarter and up)
  // tick on month boundaries ("Mar", with the year on January) so the labels
  // never pile onto each other.
  const axis = win ? Array.from({ length: win.days }, (_, i) => {
    const iso = addDays(win.startDay, i);
    let tick: boolean;
    let label = '';
    if (col >= 20) {
      tick = weekday(iso) === 0 || i === 0;
      if (tick) label = dayLabel(iso);
    } else {
      const [y, m, d] = iso.split('-').map(Number);
      tick = d === 1 || i === 0;
      if (tick) label = m === 1 || i === 0 ? `${MONTHS[m - 1]} '${String(y).slice(2)}` : MONTHS[m - 1];
    }
    return { i, iso, tick, label };
  }) : [];
  const canvasWidth = win ? win.days * col : 0;
  const todayOffset = win === null ? null
    : (parseDay(todayIso) !== null && parseDay(win.startDay) !== null
      ? Math.round(((parseDay(todayIso) as number) - (parseDay(win.startDay) as number)) / 86_400_000)
      : null);

  const rowH = (r: Row) => (r.kind === 'phase' ? H.phase : r.kind === 'add' ? H.add : r.si != null ? H.sub : H.task);

  const name = useCallback((r: Row, id: string) => {
    const isPhase = r.kind === 'phase';
    const value = isPhase ? (r as Extract<Row, { kind: 'phase' }>).phase.name : (r as Extract<Row, { kind: 'task' }>).node.name;
    const key = r.kind === 'add' ? '' : r.key;
    if (editing === key) {
      return (
        <>
          <input
            className="pgd-nameinput"
            value={value}
            placeholder={isPhase ? 'Phase name' : 'Task name'}
            aria-label={`${isPhase ? 'Phase' : 'Task'} ${id} name`}
            autoFocus
            disabled={disabled}
            onChange={(e) => props.onRename(
              e.target.value, r.pi,
              r.kind === 'task' ? r.ti : undefined, r.kind === 'task' ? r.si : undefined,
            )}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditing(null); }}
          />
          {/* The visible "commit" affordance the founder asked for. The input's
              blur already commits, so this button only needs to exist — clicking
              it blurs the input and both paths end the same way. */}
          <button
            type="button"
            className="pbx-icon pgd-nameok"
            title="Confirm name"
            aria-label={`Confirm ${isPhase ? 'phase' : 'task'} ${id} name`}
            onClick={() => setEditing(null)}
          >✓</button>
        </>
      );
    }
    return (
      <>
        <span className="pgd-nametxt" title={value}>
          {value.trim() || <em className="pgd-untitled">{isPhase ? 'Untitled phase' : 'Untitled task'}</em>}
        </span>
        <button
          type="button"
          className="pbx-icon pgd-namedit"
          title={isPhase ? 'Rename phase' : 'Rename task'}
          aria-label={`Rename ${isPhase ? 'phase' : 'task'} ${id}`}
          disabled={disabled}
          onClick={() => setEditing(key)}
        >✎</button>
      </>
    );
  }, [editing, disabled, props]);

  const owner = useCallback((nodeKey: string, assigneePartyId: string | null, label: string) => {
    const p = partyOf(dir, assigneePartyId);
    return (
      <span className="pgd-owner" title={p ? `${p.name} · ${roleWord(p.role)}` : 'Unassigned — click to assign'}>
        {p ? <PartyAvatar party={p} size="sm" /> : <UnassignedAvatar size="sm" />}
        <select
          className="pgd-ownersel"
          value={assigneePartyId ?? ''}
          aria-label={`Owner of ${label}`}
          disabled={disabled || parties.length === 0}
          onChange={(e) => props.onAssign(nodeKey, e.target.value || null)}
        >
          <option value="">Unassigned</option>
          {parties.map((m) => (
            <option key={m.partyId} value={m.partyId}>{m.name} · {roleWord(m.role)}</option>
          ))}
          {assigneePartyId && !dir.has(assigneePartyId) ? (
            <option value={assigneePartyId}>{p?.name}</option>
          ) : null}
        </select>
      </span>
    );
  }, [dir, parties, disabled, props]);

  const resizer = (c: keyof typeof COL_MIN, what: string) => (
    <span
      className="pgd-hrs" role="separator" aria-label={`Resize the ${what} column`}
      title="Drag to resize"
      onPointerDown={onResizeDown(c)} onPointerMove={onResizeMove}
      onPointerUp={onResizeUp} onPointerCancel={onResizeUp}
    />
  );

  return (
    <div
      className="pgd"
      style={{
        '--pgdw-name': colW.name ? `${colW.name}px` : undefined,
        '--pgdw-trade': colW.trade ? `${colW.trade}px` : undefined,
        '--pgdw-dates': colW.dates ? `${colW.dates}px` : undefined,
      } as React.CSSProperties}
    >
      {/* ── The time-base toolbar: pick the reading scale, or type the exact
          window. View state only — it never touches the plan. ── */}
      <div className="pgd-toolbar">
        <label className="pgd-tb-lbl">
          Timeline
          <select
            className="pgd-tb-sel" value={base} aria-label="Timeline scale"
            onChange={(e) => onPickBase(e.target.value as TimeBase)}
          >
            {BASE_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {base === 'custom' ? (
          <span className="pgd-tb-range">
            <input
              type="date" className="pgd-tb-date" value={customRange.from}
              aria-label="Timeline start"
              onChange={(e) => setCustomRange((p) => ({ ...p, from: e.target.value }))}
            />
            <span aria-hidden>–</span>
            <input
              type="date" className="pgd-tb-date" value={customRange.to}
              aria-label="Timeline end"
              onChange={(e) => setCustomRange((p) => ({ ...p, to: e.target.value }))}
            />
          </span>
        ) : null}
      </div>

      <div className="pgd-grid">
        {/* ── Left: the editable table. ── */}
        <div className="pgd-table">
          <div className="pgd-hdr" style={{ height: AXIS_H }}>
            <span /><span aria-hidden>ID</span>
            <span className="pgd-hcell"><span aria-hidden>Task</span>{resizer('name', 'task name')}</span>
            <span className="pgd-hcell"><span aria-hidden>Specialty</span>{resizer('trade', 'specialty')}</span>
            <span className="pgd-hdr-owner" aria-hidden>Owner</span>
            <span className="pgd-hcell"><span aria-hidden>Dates</span>{resizer('dates', 'dates')}</span>
            <span />
          </div>

          {rows.map((r) => {
            if (r.kind === 'add') {
              return (
                <div key={`add-${r.pi}`} className="pgd-addrow" style={{ height: H.add }}>
                  <button type="button" className="pgd-add" disabled={disabled}
                    onClick={() => setEditing(props.onAddTask(r.pi))}>+ Add task</button>
                </div>
              );
            }

            if (r.kind === 'phase') {
              const id = `P${r.pi + 1}`;
              return (
                <div
                  key={r.key}
                  className={`pgd-row pgd-row-phase${dragPhase === r.pi ? ' is-dragging' : ''}${litRows.has(r.key) ? ' is-cycle' : ''}`}
                  style={{ height: H.phase }}
                  onClick={(e) => onRowClick(e, r)}
                  onDragOver={(e) => { if (dragPhase !== null) e.preventDefault(); }}
                  onDrop={(e) => {
                    if (dragPhase === null) return;
                    e.preventDefault();
                    if (dragPhase !== r.pi) props.onReorderPhase(dragPhase, r.pi);
                    setDragPhase(null);
                  }}
                >
                  <span
                    className="pbx-grip" role="button" tabIndex={-1}
                    aria-label={`Drag to reorder phase ${r.pi + 1}`} title="Drag to reorder"
                    draggable={!disabled}
                    onDragStart={(e) => { setDragPhase(r.pi); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => setDragPhase(null)}
                  >⠿</span>
                  <span className="pgd-id">{id}</span>
                  <span className="pgd-name">{name(r, id)}</span>
                  <span className="pgd-trade">
                    <input
                      className="pgd-tradeinput" value={r.phase.trade} placeholder="Specialty"
                      maxLength={120} aria-label={`Specialty for phase ${r.pi + 1}`}
                      disabled={disabled}
                      onChange={(e) => props.onTrade(r.key, e.target.value)}
                    />
                  </span>
                  {owner(r.key, r.phase.assigneePartyId, `phase ${r.pi + 1}`)}
                  <span className="pgd-datecell" />
                  <span className="pgd-ctl">
                    <button type="button" className="pbx-icon pbx-del" title="Remove phase"
                      disabled={disabled} onClick={() => props.onRemovePhase(r.pi)}>✕</button>
                  </span>
                </div>
              );
            }

            const sub = r.si != null;
            const id = sub ? `${r.pi + 1}.${r.ti + 1}.${(r.si as number) + 1}` : `${r.pi + 1}.${r.ti + 1}`;
            const what = sub ? 'sub-task' : 'task';
            const isTaskDrag = !sub && dragTask?.pi === r.pi;
            const isSubDrag = sub && dragSub?.pi === r.pi && dragSub.ti === r.ti;
            return (
              <div
                key={r.key}
                className={`pgd-row${sub ? ' pgd-row-sub' : ''}${litRows.has(r.key) ? ' is-cycle' : ''}${(isTaskDrag && dragTask?.ti === r.ti) || (isSubDrag && dragSub?.si === r.si) ? ' is-dragging' : ''}`}
                style={{ height: rowH(r) }}
                onClick={(e) => onRowClick(e, r)}
                onDragOver={(e) => { if (isTaskDrag || isSubDrag) e.preventDefault(); }}
                onDrop={(e) => {
                  if (isTaskDrag) {
                    e.preventDefault();
                    if (dragTask && dragTask.ti !== r.ti) props.onReorderTask(r.pi, dragTask.ti, r.ti);
                    setDragTask(null);
                  } else if (isSubDrag) {
                    e.preventDefault();
                    if (dragSub && dragSub.si !== r.si) props.onReorderSubtask(r.pi, r.ti, dragSub.si, r.si as number);
                    setDragSub(null);
                  }
                }}
              >
                <span
                  className="pbx-grip" role="button" tabIndex={-1}
                  aria-label={`Drag to reorder ${what}`} title="Drag to reorder"
                  draggable={!disabled}
                  onDragStart={(e) => {
                    if (sub) setDragSub({ pi: r.pi, ti: r.ti, si: r.si as number });
                    else setDragTask({ pi: r.pi, ti: r.ti });
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => { setDragTask(null); setDragSub(null); }}
                >⠿</span>
                <span className="pgd-id">{id}</span>
                <span className="pgd-name">
                  {name(r, id)}
                  {r.node.description.trim() ? <span className="pgt-lbl-dot" aria-hidden /> : null}
                </span>
                <span className="pgd-trade">
                  <input
                    className="pgd-tradeinput" value={r.node.trade} placeholder="Specialty"
                    maxLength={120} aria-label={`Specialty for ${what} ${id}`}
                    disabled={disabled}
                    onChange={(e) => props.onTrade(r.key, e.target.value)}
                  />
                </span>
                {owner(r.key, r.node.assigneePartyId, `${what} ${id}`)}
                {/* Start and finish share ONE column (founder follow-up):
                    two inputs around a dash, reading as "start – finish". */}
                <span className="pgd-datecell pgd-dates">
                  <input
                    type="date" className="pgd-date" value={r.node.start}
                    aria-label={`${what} ${id} start date`} disabled={disabled}
                    onChange={(e) => props.onSetDate('start', e.target.value, r.pi, r.ti, r.si)}
                  />
                  <span className="pgd-datesep" aria-hidden>–</span>
                  <input
                    type="date" className="pgd-date" value={r.node.end}
                    aria-label={`${what} ${id} finish date`} disabled={disabled}
                    onChange={(e) => props.onSetDate('end', e.target.value, r.pi, r.ti, r.si)}
                  />
                </span>
                <span className="pgd-ctl">
                  {!sub ? (
                    <button type="button" className="pbx-icon" title="Add sub-task"
                      aria-label={`Add a sub-task under ${what} ${id}`} disabled={disabled}
                      onClick={() => setEditing(props.onAddSubtask(r.pi, r.ti))}>＋</button>
                  ) : null}
                  <button type="button" className="pbx-icon pbx-del" title={`Remove ${what}`}
                    disabled={disabled}
                    onClick={() => (sub
                      ? props.onRemoveSubtask(r.pi, r.ti, r.si as number)
                      : props.onRemoveTask(r.pi, r.ti))}>✕</button>
                </span>
              </div>
            );
          })}

          <div className="pgd-addrow" style={{ height: H.add }}>
            <button type="button" className="pgd-add" disabled={disabled}
              onClick={() => setEditing(props.onAddPhase())}>
              + Add phase
            </button>
          </div>
        </div>

        {/* ── Right: the always-visible timeline canvas. ── */}
        <div className="pgt-scroll">
          {win ? (
            <div className="pgt-canvas" style={{ width: canvasWidth }}>
              <div className="pgt-axis" style={{ height: AXIS_H }}>
                {axis.map((c) => (
                  <div key={c.i} className={`pgt-axis-cell${c.tick ? ' is-tick' : ''}`}
                    style={{ left: c.i * col, width: col }}>
                    {c.label ? <span className="pgt-axis-lbl">{c.label}</span> : null}
                  </div>
                ))}
              </div>

              {rows.map((r) => {
                if (r.kind === 'add') {
                  return <div key={`ta-${r.pi}`} className="pgd-track-add" style={{ height: H.add }} />;
                }
                if (r.kind === 'phase') {
                  const env = phaseEnvelope(r.phase);
                  const bar = env ? clipBarGeom(win, env.start, env.end) : null;
                  return (
                    <div key={`tp-${r.pi}`} className="pgt-band" style={{ height: H.phase }}>
                      {bar ? (
                        <div className="pgd-envbar" aria-hidden
                          style={{ left: bar.offsetDays * col + 1, width: Math.max(2, bar.spanDays * col - 2) }} />
                      ) : null}
                    </div>
                  );
                }
                const bar = clipBarGeom(win, r.node.start, r.node.end);
                const undated = !r.node.start && !r.node.end;
                return (
                  <div
                    key={`tt-${r.key}`}
                    className={`pgt-track${r.si != null ? ' is-sub' : ''}${undated && !disabled ? ' is-clickable' : ''}`}
                    style={{ height: rowH(r) }}
                    title={undated ? 'Click a day to schedule this — the bar starts there and runs one week; drag it after' : undefined}
                    onClick={(e) => onTrackClick(e, win, r)}
                  >
                    {axis.map((c) =>
                      c.tick ? <div key={c.i} className="pgt-gridline" style={{ left: c.i * col }} /> : null)}
                    {todayOffset !== null && todayOffset >= 0 && todayOffset < win.days ? (
                      <div className="pgd-today" style={{ left: todayOffset * col }} aria-hidden />
                    ) : null}
                    {bar ? (
                      <div
                        className={`pgt-bar${r.si != null ? ' is-sub' : ''}${bar.open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}
                        style={{ left: bar.offsetDays * col + 1, width: Math.max(2, bar.spanDays * col - 2) }}
                        role="button" tabIndex={-1}
                        aria-label={
                          `${r.node.name.trim() || (r.si != null ? 'Sub-task' : 'Task')}: `
                          + `${r.node.start || 'no start'} → ${r.node.end || 'no finish'}. `
                          + 'Drag to move; drag an edge to change start or finish.'
                        }
                        title="Drag to move — drag an edge to change start or finish"
                        onPointerDown={(e) => onBarDown(e, r, 'move')}
                        onPointerMove={onBarMove}
                        onPointerUp={onBarUp}
                        onPointerCancel={onBarUp}
                      >
                        {/* A clipped edge is the WINDOW's edge, not the task's —
                            no resize handle there (the body still drags). */}
                        {!bar.open && !bar.clipStart && r.node.start ? (
                          <span className="pgt-handle pgt-handle-l" aria-hidden
                            onPointerDown={(e) => onBarDown(e, r, 'resize-start')}
                            onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp} />
                        ) : null}
                        <span className="pgt-bar-lbl">{r.node.name.trim() || 'Untitled'}</span>
                        {!bar.open && !bar.clipEnd && r.node.end ? (
                          <span className="pgt-handle pgt-handle-r" aria-hidden
                            onPointerDown={(e) => onBarDown(e, r, 'resize-end')}
                            onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp} />
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <div className="pgd-track-add" style={{ height: H.add }} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
