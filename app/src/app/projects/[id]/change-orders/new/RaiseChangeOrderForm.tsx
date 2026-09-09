'use client';

// Surface 3b — Raise a change order (form body). Captures cost impact plus the
// scope / schedule / quality notes (FR8) that never move the budget. Money is
// entered in dollars and converted to integer cents on submit (§6). Posts to the
// live contract endpoint; a failure is reported as a failure — there is no
// simulated success path (LINA-57).
//
// The build id arrives as a prop from the server page (which wears PortalShell):
// a client component cannot render the server-only shell, so the page owns the
// chrome and this owns only the form.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseCostDeltaToCents } from '@/lib/format';

type Result = { kind: 'idle' | 'sending' } | { kind: 'error'; message: string } | { kind: 'ok'; id: string };

/** `{ cents }` when the typed amount is exact, `{ error }` when it is not. */
function readCostDelta(dollars: string): { cents?: number; error?: string } {
  if (!dollars.trim()) return { cents: 0 };
  try {
    return { cents: parseCostDeltaToCents(dollars) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'That cost impact is not a valid amount.' };
  }
}

export function RaiseChangeOrderForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [dollars, setDollars] = useState('');
  const [scopeImpactNote, setScope] = useState('');
  const [scheduleImpactDays, setDays] = useState('');
  const [scheduleImpactNote, setSchedNote] = useState('');
  const [qualityFlag, setQualityFlag] = useState(false);
  const [qualityNote, setQualityNote] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  // Parsed, not rounded (LINA-57): `Math.round(parseFloat(x) * 100)` used to
  // turn "4200.999" into $4201.00 silently. A cost impact that is not exactly
  // what the user typed has no business entering an append-only record.
  const { cents: costDeltaCents, error: costError } = readCostDelta(dollars);
  const valid = title.trim().length > 0 && costDeltaCents !== undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setResult({ kind: 'sending' });
    const body = {
      title: title.trim(),
      costDeltaCents,
      scopeImpactNote: scopeImpactNote.trim() || undefined,
      scheduleImpactDays: scheduleImpactDays ? parseInt(scheduleImpactDays, 10) : undefined,
      scheduleImpactNote: scheduleImpactNote.trim() || undefined,
      qualityFlag: qualityFlag || undefined,
      qualityNote: qualityFlag ? qualityNote.trim() || undefined : undefined,
    };
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/change-orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // Every non-2xx is a FAILURE, 404 included (LINA-57). The previous
      // "demo mode" branch told the user what would have happened, which on a
      // form whose whole job is to put a cost change on the record is the one
      // outcome that must never be simulated.
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setResult({
          kind: 'error',
          message: j?.error?.message ?? `The change order was not recorded (${res.status}). Nothing has changed.`,
        });
        return;
      }
      const co = await res.json();
      router.push(`/change-orders/${co.id}`);
    } catch {
      setResult({
        kind: 'error',
        message: 'The change order could not be sent, so nothing was recorded. Check your connection and try again.',
      });
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="t">Title</label>
        <input id="t" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Engineered oak flooring (kitchen & hall)" required />
      </div>

      <div className="field">
        <label htmlFor="c">Cost impact (USD)</label>
        <input id="c" inputMode="decimal" value={dollars} onChange={(e) => setDollars(e.target.value)} placeholder="4200" />
        <span className="hint">Positive increases the budget; negative reduces it. Recorded as integer cents.</span>
      </div>

      <div className="field">
        <label htmlFor="s">Scope note (optional)</label>
        <textarea id="s" value={scopeImpactNote} onChange={(e) => setScope(e.target.value)} placeholder="Oak over laminate, kitchen & hall (38 m²)…" />
        <span className="hint">Scope, schedule and quality notes are captured but never change the budget total (FR8).</span>
      </div>

      <div className="field">
        <label htmlFor="sd">Schedule impact (days, optional)</label>
        <input id="sd" inputMode="numeric" value={scheduleImpactDays} onChange={(e) => setDays(e.target.value)} placeholder="5" />
      </div>
      <div className="field">
        <label htmlFor="sn">Schedule note (optional)</label>
        <textarea id="sn" value={scheduleImpactNote} onChange={(e) => setSchedNote(e.target.value)} placeholder="Adds ~5 days to interior finishes…" />
      </div>

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: 'row' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={qualityFlag} onChange={(e) => setQualityFlag(e.target.checked)} />
          Flag a quality impact
        </label>
      </div>
      {qualityFlag && (
        <div className="field">
          <label htmlFor="qn">Quality note</label>
          <textarea id="qn" value={qualityNote} onChange={(e) => setQualityNote(e.target.value)} placeholder="Describe the quality impact…" />
        </div>
      )}

      {costError && (
        <p className="form-error" role="alert" style={{ marginBottom: 12 }}>
          <span aria-hidden="true">⚠ </span>
          {costError}
        </p>
      )}
      {costDeltaCents !== undefined && costDeltaCents !== 0 && (
        <p className="cap" style={{ marginBottom: 12 }}>
          Cost impact recorded as <strong>{costDeltaCents} cents</strong>.
        </p>
      )}

      <div className="btn-row">
        <button className="btn primary" type="submit" disabled={!valid || result.kind === 'sending'}>
          {result.kind === 'sending' ? 'Submitting…' : 'Submit for review'}
        </button>
        <a className="btn" href={`/projects/${projectId}/change-orders`}>Cancel</a>
      </div>

      {result.kind === 'error' && (
        <div className="integrity bad" role="alert" style={{ marginTop: 16 }}>
          {result.message}
        </div>
      )}
    </form>
  );
}
