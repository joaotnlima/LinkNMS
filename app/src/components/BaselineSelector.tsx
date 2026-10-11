'use client';

// PRD-10 E-1 — the plan header's baseline selector (D-24: a baseline is a label
// on a branch; no baselines page). The list and every number drawn against the
// choice are the server's: choosing navigates to `?baseline=` and the schedule
// read draws that baseline's branch against it (getSchedule ?baseline=).
import { useRouter } from 'next/navigation';

import type { BaselineOption } from '@/lib/v2/execution-view';
import './site.css';

export function BaselineSelector({
  projectId, options, selected,
}: {
  projectId: string;
  options: BaselineOption[];
  /** The chosen baseline id, or null for "each branch's latest". */
  selected: string | null;
}) {
  const router = useRouter();
  if (!options.length) return null;
  const chosen = options.find((o) => o.id === selected) ?? null;
  return (
    <div className="ste-baseline" role="group" aria-label="Compare the plan against a baseline">
      <label htmlFor="ste-baseline-select">Compare against</label>
      <select
        id="ste-baseline-select"
        value={chosen?.id ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          router.push(`/projects/${projectId}/plan${v ? `?baseline=${encodeURIComponent(v)}` : ''}`);
        }}
      >
        <option value="">Each branch’s latest baseline</option>
        {options.map((o) => (
          <option key={o.id} value={o.id} title={o.detail}>{o.label} — {o.detail}</option>
        ))}
      </select>
      {chosen ? <span className="ste-quiet">Drawn against {chosen.label} · {chosen.detail}</span> : null}
    </div>
  );
}
