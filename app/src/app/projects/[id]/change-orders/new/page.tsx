'use client';

// Surface 3b — Raise a change order. Captures cost impact plus the scope /
// schedule / quality notes (FR8) that never move the budget. Money is entered in
// dollars and converted to integer cents on submit (§6). Posts to the live
// contract endpoint; in demo mode (no backend) it explains what would happen
// rather than pretending to persist.
import { useState } from 'react';
import { useRouter, useParams } from 'next/navigation';

type Result = { kind: 'idle' | 'sending' } | { kind: 'demo' } | { kind: 'error'; message: string } | { kind: 'ok'; id: string };

export default function RaiseChangeOrder() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [title, setTitle] = useState('');
  const [dollars, setDollars] = useState('');
  const [scopeImpactNote, setScope] = useState('');
  const [scheduleImpactDays, setDays] = useState('');
  const [scheduleImpactNote, setSchedNote] = useState('');
  const [qualityFlag, setQualityFlag] = useState(false);
  const [qualityNote, setQualityNote] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  const costDeltaCents = Math.round(parseFloat(dollars || '0') * 100);
  const valid = title.trim().length > 0 && Number.isFinite(costDeltaCents);

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
      const res = await fetch(`/api/v1/projects/${id}/change-orders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 404 || res.status === 501) {
        setResult({ kind: 'demo' });
        return;
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setResult({ kind: 'error', message: j?.error?.message ?? `Request failed (${res.status})` });
        return;
      }
      const co = await res.json();
      router.push(`/change-orders/${co.id}`);
    } catch {
      // No backend reachable in this deployment — treat as demo.
      setResult({ kind: 'demo' });
    }
  }

  return (
    <>
      <header className="topbar">
        <a className="back" href={`/projects/${id}/change-orders`}>‹ Change orders</a>
      </header>
      <main className="screen">
        <div>
          <h1 className="scr">Raise change order</h1>
          <p className="sub">Opens as <strong>proposed</strong>. The budget only moves once the other party approves.</p>
        </div>

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

          {costDeltaCents !== 0 && Number.isFinite(costDeltaCents) && (
            <p className="cap" style={{ marginBottom: 12 }}>
              Cost impact recorded as <strong>{costDeltaCents} cents</strong>.
            </p>
          )}

          <div className="btn-row">
            <button className="btn primary" type="submit" disabled={!valid || result.kind === 'sending'}>
              {result.kind === 'sending' ? 'Submitting…' : 'Submit for review'}
            </button>
            <a className="btn" href={`/projects/${id}/change-orders`}>Cancel</a>
          </div>
        </form>

        {result.kind === 'demo' && (
          <div className="demo-banner" role="status" style={{ marginTop: 16 }}>
            <strong>Demo mode.</strong> This would create a <em>proposed</em> change order via{' '}
            <code>POST /api/v1/projects/{id}/change-orders</code> and route you to its one-screen detail.
            The Change-Order API (Slice 4) isn't wired to this deployment yet.
          </div>
        )}
        {result.kind === 'error' && (
          <div className="integrity bad" role="alert" style={{ marginTop: 16 }}>
            {result.message}
          </div>
        )}
      </main>
    </>
  );
}
