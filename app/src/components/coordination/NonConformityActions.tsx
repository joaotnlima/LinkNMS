'use client';

// PRD-12 N-3 — the next step on one non-conformity, exactly the ones the server
// offered (`actions`): assign (pick the organisation), mark fixed, close, or
// reject the fix with a reason. Only the raiser ever sees close / reject — and
// the server refuses anyone else regardless.
import { useState } from 'react';

import { moveNcAction } from '@/lib/v2/quality-actions';
import { ACTION_LABEL, type NcAction } from '@/lib/v2/quality-view';

type Option = { id: string; name: string };

export function NonConformityActions({ projectId, ncId, actions, orgs }: {
  projectId: string; ncId: string; actions: NcAction[]; orgs: Option[];
}) {
  const [open, setOpen] = useState<NcAction | null>(null);
  const [note, setNote] = useState('');
  const [org, setOrg] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!actions.length) return null;

  async function go(action: NcAction) {
    if (action === 'reject_fix' && !note.trim()) { setError('Say why the fix is not accepted.'); return; }
    if (action === 'assign' && !org) { setError('Pick the organisation that fixes it.'); return; }
    setBusy(true); setError(null);
    const res = await moveNcAction(projectId, ncId, action, { note, assignedToOrgId: org });
    setBusy(false);
    if (!res.ok) { setError(res.message); return; }
    setOpen(null); setNote(''); setOrg('');
  }

  return (
    <div className="crd-act">
      {open ? (
        <>
          {open === 'assign' ? (
            <select className="ste-field" aria-label="Organisation" value={org} onChange={(e) => setOrg(e.target.value)}>
              <option value="">Who fixes it…</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          ) : null}
          <textarea className="ste-field" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={open === 'reject_fix' ? 'Why the fix is not accepted' : open === 'fix' ? 'What was done (optional)' : 'Note (optional)'} />
          <button type="button" className={`btn${open === 'reject_fix' ? ' reject' : ' primary'}`} disabled={busy} onClick={() => void go(open)}>
            {ACTION_LABEL[open]}
          </button>
          <button type="button" className="btn" onClick={() => { setOpen(null); setError(null); }}>Cancel</button>
        </>
      ) : actions.map((a) => (
        <button key={a} type="button" className={`btn${a === 'reject_fix' ? ' reject' : a === 'close' ? ' approve' : ''}`}
          onClick={() => setOpen(a)}>{ACTION_LABEL[a]}</button>
      ))}
      {error ? <p className="ste-error" role="alert">{error}</p> : null}
    </div>
  );
}
