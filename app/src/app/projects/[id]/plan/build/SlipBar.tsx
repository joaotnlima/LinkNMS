'use client';

// PRD-13 B6 — changes against the baseline, drawn on the bar. Everything here is
// PAINT: the segments, their working-day counts and causes come from the server
// (`Task.segments`, doc 05 §5 — "no client computes them"); this file only maps
// their dates to pixels with the SAME day geometry the bars use (clipBarGeom +
// barRect), so a clay segment can never drift from the bar it annotates.
//
//   baseline    dashed ghost, only where the bar moved (S-1)
//   delay_start clay hatch on the ghost (S-1)
//   extension   solid clay from the baseline finish to the current finish (S-1, S-3)
//   overrun     hatched clay from the current finish to today, arrow tip (S-2, S-9)
//   projected   dashed clay outline — the push an overrun would make (D-44)
//   label       "+5 wd · moved by TN" … never colour alone (S-4)
import { addDays, barRect, clipBarGeom, type GanttWindow } from '@/lib/plan-gantt';
import '@/components/plan-slip.css';
import {
  barLabel, deltaWord, type LabelContext, type SlipSegment, type TaskSlip,
} from '@/lib/v2/slip-view';

/** The pixel box of [from..to] (inclusive days), or null when off-window / empty. */
function box(win: GanttWindow, col: number, from: string, to: string) {
  if (to < from) return null;
  const g = clipBarGeom(win, from, to);
  return g ? barRect(g.offsetDays, g.spanDays, col) : null;
}

/** A clay span AFTER `from` (exclusive) up to `to` (inclusive) — it abuts the bar. */
function after(win: GanttWindow, col: number, seg: SlipSegment) {
  return box(win, col, addDays(seg.from, 1), seg.to);
}

export function SlipSegments({
  slip, win, col, labels, isSummary = false,
}: {
  slip: TaskSlip;
  win: GanttWindow;
  col: number;
  labels: LabelContext;
  isSummary?: boolean;
}) {
  const out: React.ReactNode[] = [];
  let labelX: number | null = null;
  const reach = (b: { x: number; width: number } | null) => {
    if (b) labelX = Math.max(labelX ?? 0, b.x + b.width);
  };
  for (const seg of slip.segments) {
    if (seg.kind === 'baseline' && seg.moved) {
      const b = box(win, col, seg.from, seg.to);
      if (b) out.push(<div key="ghost" className="slp-ghost" style={{ left: b.x, width: b.width }} aria-hidden />);
    } else if (seg.kind === 'delay_start') {
      const b = box(win, col, seg.from, addDays(seg.to, -1));
      if (b) out.push(<div key="delay" className="slp-ghost is-hatch" style={{ left: b.x, width: b.width }} aria-hidden />);
    } else if (seg.kind === 'extension' && !isSummary) {
      const b = after(win, col, seg);
      if (b) out.push(<div key="ext" className="slp-ext" style={{ left: b.x, width: b.width }} aria-hidden />);
      reach(b);
    } else if (seg.kind === 'overrun') {
      const b = after(win, col, seg);
      if (b) out.push(<div key="over" className="slp-ext is-over" style={{ left: b.x, width: b.width }} aria-hidden />);
      reach(b);
    } else if (seg.kind === 'projected') {
      const b = after(win, col, seg);
      if (b) out.push(<div key="proj" className="slp-proj" style={{ left: b.x, width: b.width }} aria-hidden />);
      reach(b);
    } else if (seg.kind === 'current' || seg.kind === 'actual') {
      reach(box(win, col, seg.from, seg.to));
    }
  }
  const label = barLabel(slip, labels);
  if (label && labelX != null) {
    out.push(
      <span key="lbl" className={`slp-tag${label.tone === 'ok' ? ' is-ok' : ''}`} style={{ left: labelX }}>
        {label.text}
      </span>,
    );
  }
  return <>{out}</>;
}

/** S-5: the "vs baseline" cell — clay +n wd, muted on plan, green −n wd. */
export function SlipDeltaCell({ slip }: { slip: TaskSlip | undefined }) {
  const word = deltaWord(slip?.deltaWd ?? null);
  if (!word) return <span className="slp-dlt is-none" aria-label="No baseline">—</span>;
  return <span className={`slp-dlt is-${word.tone}`}>{word.text}</span>;
}

/** S-8: the legend under the grid. */
export function SlipLegend() {
  return (
    <div className="slp-legend" role="note" aria-label="How changes against the baseline are drawn">
      <span><i className="slp-lg is-planned" aria-hidden />Planned</span>
      <span><i className="slp-lg is-ext" aria-hidden />Extended — someone moved the finish</span>
      <span><i className="slp-lg is-over" aria-hidden />Overdue — not closed, grows to today</span>
      <span><i className="slp-lg is-proj" aria-hidden />Pushed by an overdue task — a projection, not saved</span>
      <span><i className="slp-lg is-ghost" aria-hidden />Baseline, where the bar moved</span>
      <span><i className="slp-lg is-done" aria-hidden />Done</span>
      <span className="slp-legend-note">Every clay segment carries a label — never colour alone.</span>
    </div>
  );
}
