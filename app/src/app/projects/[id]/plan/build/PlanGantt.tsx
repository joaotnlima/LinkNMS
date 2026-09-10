'use client';

// The timeline (Gantt) half of the "Build the plan here" editor (LINA-236).
//
// Pen: "S · (new) · Build the plan — schedule (Gantt)". The list view lets the
// author TYPE each task's start/finish; this view lets them DRAG it: grab a bar
// to move the task (both ends shift, duration preserved), grab an edge to change
// just the start or the finish. Every drop writes the same task dates the list
// edits, through the same tested authoring ops — this component owns no date
// state of its own. All the arithmetic (day snapping, clamping, no timezone
// drift) lives in @/lib/plan-gantt and is unit-tested; here is layout + pointer
// plumbing only.
//
// WHAT ISN'T HERE (deliberate): a task with no dates yet has no bar to grab —
// its first date is typed in the list view, then it appears on the timeline.
// Keyboard scheduling stays in the list (date inputs); the Gantt is the pointer
// affordance, exactly as row reordering is drag-only in the list.
import { useCallback, useMemo, useRef } from 'react';

import { addDays, applyDrag, barGeom, ganttWindow, type DragMode } from '@/lib/plan-gantt';
import type { PhaseDraft } from '@/lib/plan-authoring';

/** Pixels per day column. Wide enough to grab an edge; the canvas scrolls. */
const COL = 30;

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

// A bar row is a task OR one of its sub-tasks (LINA-244). `si` is what tells
// them apart, all the way down to the write: undefined → the task's own dates,
// a number → that sub-task's. Sub-tasks are drawn as a third bar weight,
// indented under their task exactly as the list indents them a third level.
type Row =
  | { kind: 'phase'; pi: number; name: string }
  | {
      kind: 'task'; pi: number; ti: number; si?: number;
      name: string; start: string; end: string; hasNote: boolean;
    };

export function PlanGantt({
  phases, disabled, onDates, onOpenTask,
}: {
  phases: PhaseDraft[];
  disabled?: boolean;
  /**
   * Persist a row's new dates (the drag result) through the editor's ops.
   * `si` is undefined for a task and the sub-task index for a sub-task.
   */
  onDates: (pi: number, ti: number, start: string, end: string, si?: number) => void;
  onOpenTask: (pi: number, ti: number, si?: number) => void;
}) {
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    phases.forEach((p, pi) => {
      out.push({ kind: 'phase', pi, name: p.name });
      p.tasks.forEach((t, ti) => {
        out.push({
          kind: 'task', pi, ti, name: t.name, start: t.start, end: t.end,
          hasNote: t.description.trim() !== '',
        });
        (t.children ?? []).forEach((s, si) =>
          out.push({
            kind: 'task', pi, ti, si, name: s.name, start: s.start, end: s.end,
            hasNote: s.description.trim() !== '',
          }));
      });
    });
    return out;
  }, [phases]);

  // The window spans every dated row INCLUDING sub-tasks — a plan dated only at
  // the third level still has a timeline rather than the "nothing scheduled"
  // hint (LINA-244).
  const win = useMemo(
    () => ganttWindow(rows.filter((r) => r.kind === 'task').map((r) => ({ start: r.start, end: r.end }))),
    [rows],
  );

  // Live drag. The origin dates are captured at pointer-down so every move
  // computes from the SAME baseline (idempotent) rather than compounding.
  const drag = useRef<
    null | {
      pi: number; ti: number; si?: number;
      mode: DragMode; startX: number; start: string; end: string;
    }
  >(null);

  const onDown = useCallback((
    e: React.PointerEvent, r: Extract<Row, { kind: 'task' }>, mode: DragMode,
  ) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { pi: r.pi, ti: r.ti, si: r.si, mode, startX: e.clientX, start: r.start, end: r.end };
  }, [disabled]);

  const onMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = applyDrag(d.mode, d.start, d.end, e.clientX - d.startX, COL);
    onDates(d.pi, d.ti, next.start, next.end, d.si);
  }, [onDates]);

  const onUp = useCallback((e: React.PointerEvent) => {
    if (!drag.current) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    drag.current = null;
  }, []);

  if (!win) {
    return (
      <div className="pgt-empty">
        <p>Nothing is scheduled yet.</p>
        <p className="pgt-empty-hint">
          Give a task or sub-task a start or finish date in the list, and it will appear here as a
          bar you can drag.
        </p>
      </div>
    );
  }

  // One label per week boundary (Mondays), plus the very first column.
  const axis = Array.from({ length: win.days }, (_, i) => {
    const iso = addDays(win.startDay, i);
    const wd = weekday(iso);
    return { i, iso, tick: wd === 0 || i === 0, label: (wd === 0 || i === 0) ? dayLabel(iso) : '' };
  });
  const canvasWidth = win.days * COL;

  return (
    <div className="pgt">
      <div className="pgt-grid">
        {/* Left: sticky task labels, aligned row-for-row with the tracks. */}
        <div className="pgt-labels" aria-hidden={false}>
          <div className="pgt-axis-spacer" />
          {rows.map((r) =>
            r.kind === 'phase' ? (
              <div key={`lp-${r.pi}`} className="pgt-lbl-phase" title={r.name}>
                {r.name || `Phase ${r.pi + 1}`}
              </div>
            ) : (
              <button
                key={`lt-${r.pi}-${r.ti}-${r.si ?? 'x'}`}
                type="button"
                className={`pgt-lbl-task${r.si != null ? ' is-sub' : ''}`}
                title={`Open details for ${r.name.trim() || (r.si != null ? 'this sub-task' : 'this task')}`}
                onClick={() => onOpenTask(r.pi, r.ti, r.si)}
              >
                <span className="pgt-lbl-txt">
                  {r.name.trim() || (r.si != null ? 'Untitled sub-task' : 'Untitled task')}
                </span>
                {r.hasNote ? <span className="pgt-lbl-dot" aria-hidden /> : null}
              </button>
            ),
          )}
        </div>

        {/* Right: scrollable canvas — a day axis over the tracks. */}
        <div className="pgt-scroll">
          <div className="pgt-canvas" style={{ width: canvasWidth }}>
            <div className="pgt-axis" style={{ height: 28 }}>
              {axis.map((c) => (
                <div
                  key={c.i}
                  className={`pgt-axis-cell${c.tick ? ' is-tick' : ''}`}
                  style={{ left: c.i * COL, width: COL }}
                >
                  {c.label ? <span className="pgt-axis-lbl">{c.label}</span> : null}
                </div>
              ))}
            </div>

            {rows.map((r) => {
              if (r.kind === 'phase') return <div key={`tp-${r.pi}`} className="pgt-band" />;
              const bar = barGeom(win, r.start, r.end);
              return (
                <div
                  key={`tt-${r.pi}-${r.ti}-${r.si ?? 'x'}`}
                  className={`pgt-track${r.si != null ? ' is-sub' : ''}`}
                >
                  {axis.map((c) =>
                    c.tick ? (
                      <div key={c.i} className="pgt-gridline" style={{ left: c.i * COL }} />
                    ) : null,
                  )}
                  {bar ? (
                    <div
                      className={`pgt-bar${r.si != null ? ' is-sub' : ''}${bar.open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}
                      style={{ left: bar.offsetDays * COL + 1, width: bar.spanDays * COL - 2 }}
                      role="button"
                      tabIndex={-1}
                      aria-label={
                        `${r.name.trim() || (r.si != null ? 'Sub-task' : 'Task')}: `
                        + `${r.start || 'no start'} → ${r.end || 'no finish'}. `
                        + 'Drag to move; drag an edge to change start or finish.'
                      }
                      title="Drag to move — drag an edge to change start or finish"
                      onPointerDown={(e) => onDown(e, r, 'move')}
                      onPointerMove={onMove}
                      onPointerUp={onUp}
                      onPointerCancel={onUp}
                    >
                      {!bar.open && r.start ? (
                        <span
                          className="pgt-handle pgt-handle-l"
                          aria-hidden
                          onPointerDown={(e) => onDown(e, r, 'resize-start')}
                          onPointerMove={onMove}
                          onPointerUp={onUp}
                          onPointerCancel={onUp}
                        />
                      ) : null}
                      <span className="pgt-bar-lbl">{r.name.trim() || 'Untitled'}</span>
                      {!bar.open && r.end ? (
                        <span
                          className="pgt-handle pgt-handle-r"
                          aria-hidden
                          onPointerDown={(e) => onDown(e, r, 'resize-end')}
                          onPointerMove={onMove}
                          onPointerUp={onUp}
                          onPointerCancel={onUp}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
