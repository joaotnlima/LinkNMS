'use client';

// The markup layer over a sheet (PRD-06 V-5, V-6, V-16): one SVG in SHEET UNITS
// (PDF points at scale 1, or the DWG preview's own viewBox) laid exactly over the
// rendered page, so a markup keeps its place at any zoom. It draws saved markups
// and drafts, and — in Markup mode — turns a drag or a click into points for the
// active tool. It never writes: the viewer collects drafts and saves them.
import { useRef, useState } from 'react';

import {
  cloudPath, measureLabel, type MarkupKind, type MarkupView, type Point,
} from '@/lib/v2/viewer-view';

export type Tool = MarkupKind;

export interface SheetBox { x: number; y: number; width: number; height: number }

type Shown = MarkupView & { n: number; fromVersion: number | null };

const ONE_CLICK: ReadonlySet<Tool> = new Set<Tool>(['text']);

export function MarkupLayer({
  box, markups, calibrations, mmPerUnit, tool, selectedId, onSelect, onDrawn,
}: {
  box: SheetBox;
  markups: Shown[];
  /** Calibration markups of this sheet (drawn dashed, not numbered). */
  calibrations: MarkupView[];
  mmPerUnit: number | null;
  /** The active tool in Markup mode; null in View mode (no drawing). */
  tool: Tool | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDrawn: (tool: Tool, points: Point[]) => void;
}) {
  const svg = useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const unit = Math.max(box.width, box.height) / 700;

  function toSheet(e: React.PointerEvent): Point | null {
    const el = svg.current;
    const ctm = el?.getScreenCTM();
    if (!el || !ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return [round(p.x), round(p.y)];
  }

  function down(e: React.PointerEvent<SVGSVGElement>) {
    if (!tool) return;
    const p = toSheet(e);
    if (!p) return;
    if (ONE_CLICK.has(tool)) { onDrawn(tool, [p]); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: p, to: p });
  }
  function move(e: React.PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    const p = toSheet(e);
    if (p) setDrag({ ...drag, to: p });
  }
  function up() {
    if (!drag || !tool) return;
    const { from, to } = drag;
    setDrag(null);
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) < unit * 2) return; // a click, not a drag
    onDrawn(tool, [from, to]);
  }

  const stroke = { strokeWidth: unit * 1.6 };
  return (
    <svg
      ref={svg}
      className={`mk-layer${tool ? ' is-drawing' : ''}`}
      viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
      preserveAspectRatio="none"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      role="img"
      aria-label="Markups on this sheet"
    >
      {calibrations.map((c) => (
        <g key={c.id} className="mk-cal">
          <line x1={c.points[0][0]} y1={c.points[0][1]} x2={c.points[1][0]} y2={c.points[1][1]} {...stroke} strokeDasharray="6 4" />
          <text x={mid(c.points)[0]} y={mid(c.points)[1] - unit * 3} fontSize={unit * 8} textAnchor="middle">
            calibrated · {Math.round(c.lengthMm ?? 0).toLocaleString('en-GB')} mm
          </text>
        </g>
      ))}
      {markups.map((m) => (
        <g key={m.id} className={`mk-shape is-${m.kind}${m.state === 'closed' ? ' is-closed' : ''}${m.draft ? ' is-draft' : ''}${m.id === selectedId ? ' is-on' : ''}${m.fromVersion ? ' is-older' : ''}`}
          onPointerDown={(e) => { if (!tool) { e.stopPropagation(); onSelect(m.id); } }}>
          <Shape m={m} unit={unit} mmPerUnit={mmPerUnit} stroke={stroke} />
          <Badge at={badgeAt(m, unit)} n={m.n} unit={unit} />
        </g>
      ))}
      {drag && tool ? (
        <g className="mk-shape is-draft is-live">
          <Shape m={{ kind: tool, points: [drag.from, drag.to], text: null } as MarkupView} unit={unit} mmPerUnit={mmPerUnit} stroke={stroke} />
        </g>
      ) : null}
    </svg>
  );
}

function Shape({ m, unit, mmPerUnit, stroke }: {
  m: Pick<MarkupView, 'kind' | 'points' | 'text'>; unit: number; mmPerUnit: number | null;
  stroke: { strokeWidth: number };
}) {
  const [a, b] = m.points;
  if (m.kind === 'cloud' && b) return <path d={cloudPath([a, b], unit * 6)} fill="none" {...stroke} />;
  if ((m.kind === 'arrow') && b) {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const h = unit * 7;
    const left: Point = [b[0] - h * Math.cos(ang - 0.4), b[1] - h * Math.sin(ang - 0.4)];
    const right: Point = [b[0] - h * Math.cos(ang + 0.4), b[1] - h * Math.sin(ang + 0.4)];
    return (
      <>
        <path d={`M ${a[0]} ${a[1]} L ${b[0]} ${b[1]} M ${left[0]} ${left[1]} L ${b[0]} ${b[1]} L ${right[0]} ${right[1]}`} fill="none" {...stroke} />
        {m.text ? <text x={a[0] + unit * 3} y={a[1] - unit * 3} fontSize={unit * 8}>{m.text}</text> : null}
      </>
    );
  }
  if ((m.kind === 'measure' || m.kind === 'calibration') && b) {
    const [mx, my] = mid([a, b]);
    return (
      <>
        <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...stroke} />
        <text x={mx} y={my - unit * 3} fontSize={unit * 8} textAnchor="middle">
          {m.kind === 'measure' ? measureLabel([a, b], mmPerUnit) : 'calibrate…'}
        </text>
      </>
    );
  }
  if (m.kind === 'text') {
    return <text x={a[0]} y={a[1]} fontSize={unit * 9} className="mk-text">{m.text ?? 'Text'}</text>;
  }
  return null;
}

function Badge({ at, n, unit }: { at: Point; n: number; unit: number }) {
  return (
    <g className="mk-badge">
      <circle cx={at[0]} cy={at[1]} r={unit * 6} />
      <text x={at[0]} y={at[1] + unit * 2.5} fontSize={unit * 7} textAnchor="middle">{n}</text>
    </g>
  );
}

function badgeAt(m: MarkupView, unit: number): Point {
  if (m.kind === 'cloud' && m.points[1]) {
    return [Math.max(m.points[0][0], m.points[1][0]) + unit * 6, Math.min(m.points[0][1], m.points[1][1]) - unit * 6];
  }
  return [m.points[0][0] - unit * 8, m.points[0][1] - unit * 8];
}

function mid(points: Point[]): Point {
  const [a, b] = points;
  return b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : a;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
