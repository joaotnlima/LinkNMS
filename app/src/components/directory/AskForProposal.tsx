'use client';

// "Ask for a proposal" on a company profile (PRD-04 X-6, X-7; design C1). Pick
// a build, then a task — tasks matching the company's specialties first — and
// add the company to that task's RFP DRAFT, or to a new draft prefilled from
// the task. NOTHING IS SENT from here: the company is queued on the draft with
// source "Directory"; the RFP goes out from the task panel. A tender already
// out for bids is not offered (adding there would send a link at once).
// Shortlists (X-8, Could) are not built.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  askForProposalAction, loadAskBuildsAction, loadAskTasksAction,
} from '@/components/rfp-directory-actions';
import type { V2Specialty } from '@/lib/v2/directory-view';
import { askTarget, rankTasksForCompany, type AskTask } from '@/lib/v2/rfp-directory-view';

export function AskForProposal({ companyId, companyName, companySpecialties, taxonomy, where }: {
  companyId: string;
  companyName: string;
  companySpecialties: string[];
  taxonomy: V2Specialty[];
  /** "Roofing · Tiled roofs" — the header's second line. */
  where: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [builds, setBuilds] = useState<{ id: string; name: string }[] | null>(null);
  const [buildId, setBuildId] = useState('');
  const [tasks, setTasks] = useState<AskTask[] | null>(null);
  const [taskId, setTaskId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open || builds) return;
    void loadAskBuildsAction().then((b) => { setBuilds(b); if (b.length === 1) setBuildId(b[0].id); });
  }, [open, builds]);

  useEffect(() => {
    if (!buildId) { setTasks(null); return; }
    setTasks(null); setTaskId('');
    void loadAskTasksAction(buildId).then(setTasks);
  }, [buildId]);

  const ranked = useMemo(() => rankTasksForCompany(tasks ?? [], companySpecialties, taxonomy), [tasks, companySpecialties, taxonomy]);
  const task = ranked.find((t) => t.id === taskId) ?? null;
  const target = task ? askTarget(task) : null;

  const submit = async (openTask: boolean) => {
    if (!task || !buildId) return;
    setBusy(true); setError(null);
    const res = await askForProposalAction({ projectId: buildId, task, companyId });
    setBusy(false);
    if (!res.ok) { setError(res.message); return; }
    if (openTask) { router.push(res.data.href); return; }
    setDone(`${companyName} is on the ${res.data.created ? 'new ' : ''}draft for ${task.name}. Send it from the task panel.`);
    setTaskId('');
    setTasks(await loadAskTasksAction(buildId));
  };

  if (!open) {
    return <button type="button" className="btn primary" onClick={() => setOpen(true)}>Ask for a proposal</button>;
  }
  return (
    <section className="card" role="dialog" aria-label={`Ask ${companyName} for a proposal`} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <b>Ask for a proposal</b>
          <div className="cap">{companyName}{where ? ` · ${where}` : ''}</div>
        </div>
        <button type="button" className="btn" aria-label="Close" onClick={() => setOpen(false)}>✕</button>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="cap">Build</span>
        {builds === null ? <span className="cap">Loading your builds…</span> : builds.length === 0 ? (
          <span className="cap">You have no build to ask for. Create one first.</span>
        ) : (
          <select value={buildId} onChange={(e) => setBuildId(e.target.value)}>
            <option value="">Pick a build</option>
            {builds.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
      </label>

      {buildId ? (
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <legend className="cap">Which work · tasks matching this company&apos;s specialties are listed first.</legend>
          {tasks === null ? <span className="cap">Reading the plan…</span> : ranked.length === 0 ? (
            <span className="cap">This build has no tasks yet.</span>
          ) : ranked.map((t) => {
            const where = askTarget(t);
            return (
              <label key={t.id} className="lrow" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="radio" name="ask-task" value={t.id} checked={taskId === t.id} disabled={where.kind === 'locked'}
                  onChange={() => setTaskId(t.id)} />
                <span style={{ flex: 1 }}>{t.name}</span>
                {t.match ? <span className="badge ok">Specialty match</span> : <span className="badge neutral">No specialty match</span>}
                {t.rfp && t.rfp.status !== 'cancelled'
                  ? <span className="badge neutral">{t.rfp.status === 'draft' ? 'Draft — not sent' : 'Out for bids'}</span> : null}
              </label>
            );
          })}
        </fieldset>
      ) : null}

      {task && target ? (
        <p className="cap" style={{ margin: 0 }}>
          {target.kind === 'draft' ? `Add to: the RFP draft “${task.rfp?.title ?? task.name}” · ${task.rfp?.invited_count ?? 0} bidders so far · not sent yet.`
            : target.kind === 'new' ? `Add to: a new RFP for ${task.name}, prefilled from the task. It stays a draft.`
              : target.reason}
        </p>
      ) : null}
      <p className="cap" style={{ margin: 0 }}>
        Nothing is sent from here. The company is added to the draft as a bidder with source “Directory”; you send the RFP from the task panel.
      </p>
      {error ? <p className="derr" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      {done ? <p role="status" style={{ margin: 0 }}>{done}</p> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button type="button" className="btn" disabled={busy || !task || target?.kind === 'locked'} onClick={() => void submit(false)}>
          Add and keep searching
        </button>
        <button type="button" className="btn primary" disabled={busy || !task || target?.kind === 'locked'} onClick={() => void submit(true)}>
          {busy ? 'Adding…' : 'Add and open the task'}
        </button>
      </div>
    </section>
  );
}
