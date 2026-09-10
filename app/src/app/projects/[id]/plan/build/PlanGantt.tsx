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

type Row =
  | { kind: 'phase'; pi: number; name: string }
  | { kind: 'task'; pi: number; ti: number; name: string; start: string; end: string; hasNote: boolean };

export function PlanGantt({
  phases, disabled, onDates, onOpenTask,
}: {
  phases: PhaseDraft[];
  disabled?: boolean;
  /** Persist a task's new dates (the drag result) through the editor's ops. */
  onDates: (pi: number, ti: number, start: string, end: string) => void;
  onOpenTask: (pi: number, ti: number) => void;
}) {
  const win = useMemo(
    () => ganttWindow(phases.flatMap((p) => p.tasks.map((t) => ({ start: t.start, end: t.end })))),
    [phases],
  );

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    phases.forEach((p, pi) => {
      out.push({ kind: 'phase', pi, name: p.name });
      p.tasks.forEach((t, ti) =>
        out.push({
          kind: 'task', pi, ti, name: t.name, start: t.start, end: t.end,
          hasNote: t.description.trim() !== '',
        }));
    });
    return out;
  }, [phases]);

  // Live drag. The origin dates are captured at pointer-down so every move
  // computes from the SAME baseline (idempotent) rather than compounding.
  const drag = useRef<
    null | { pi: number; ti: number; mode: DragMode; startX: number; start: string; end: string }
  >(null);

  const onDown = useCallback((
    e: React.PointerEvent, pi: number, ti: number, mode: DragMode, start: string, end: string,
  ) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { pi, ti, mode, startX: e.clientX, start, end };
  }, [disabled]);

  const onMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const next = applyDrag(d.mode, d.start, d.end, e.clientX - d.startX, COL);
    onDates(d.pi, d.ti, next.start, next.end);
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
          Give a task a start or finish date in the list, and it will appear here as a bar you can drag.
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
                key={`lt-${r.pi}-${r.ti}`}
                type="button"
                className="pgt-lbl-task"
                title={`Open details for ${r.name.trim() || 'this task'}`}
                onClick={() => onOpenTask(r.pi, r.ti)}
              >
                <span className="pgt-lbl-txt">{r.name.trim() || 'Untitled task'}</span>
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
                <div key={`tt-${r.pi}-${r.ti}`} className="pgt-track">
                  {axis.map((c) =>
                    c.tick ? (
                      <div key={c.i} className="pgt-gridline" style={{ left: c.i * COL }} />
                    ) : null,
                  )}
                  {bar ? (
                    <div
                      className={`pgt-bar${bar.open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}
                      style={{ left: bar.offsetDays * COL + 1, width: bar.spanDays * COL - 2 }}
                      role="button"
                      tabIndex={-1}
                      aria-label={
                        `${r.name.trim() || 'Task'}: ${r.start || 'no start'} → ${r.end || 'no finish'}. `
                        + 'Drag to move; drag an edge to change start or finish.'
                      }
                      title="Drag to move — drag an edge to change start or finish"
                      onPointerDown={(e) => onDown(e, r.pi, r.ti, 'move', r.start, r.end)}
                      onPointerMove={onMove}
                      onPointerUp={onUp}
                      onPointerCancel={onUp}
                    >
                      {!bar.open && r.start ? (
                        <span
                          className="pgt-handle pgt-handle-l"
                          aria-hidden
                          onPointerDown={(e) => onDown(e, r.pi, r.ti, 'resize-start', r.start, r.end)}
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
                          onPointerDown={(e) => onDown(e, r.pi, r.ti, 'resize-end', r.start, r.end)}
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
