'use client';

// PRD-12 N-5 (flows C16–C17) — ask on the build or on a task: a clarification,
// a design change for the architect to approve, or a scope gap — work nobody
// holds, which the server always routes to the owner.
import { useRef, useState } from 'react';

import { askQuestionAction } from '@/lib/v2/questions-actions';
import { TOPIC_LABEL, askBody, type AskForm, type QuestionTopic } from '@/lib/v2/questions-view';

type Option = { id: string; name: string };
const EMPTY: AskForm = { topic: 'clarification', body: '', addresseeOrgId: '', taskId: '' };

export function AskQuestion({ projectId, orgs, tasks }: { projectId: string; orgs: Option[]; tasks: Option[] }) {
  const [form, setForm] = useState<AskForm>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const clientId = useRef<string | null>(null);
  const set = (patch: Partial<AskForm>) => { clientId.current = null; setForm((f) => ({ ...f, ...patch })); };

  async function submit() {
    if (!clientId.current) clientId.current = crypto.randomUUID();
    const built = askBody(form, clientId.current);
    if (!built.ok) { setMessage({ ok: false, text: built.message }); return; }
    setBusy(true); setMessage(null);
    const res = await askQuestionAction(projectId, built.objectType, built.objectId, built.body);
    setBusy(false);
    if (!res.ok) { setMessage({ ok: false, text: res.message }); return; }
    clientId.current = null;
    setForm(EMPTY);
    setMessage({ ok: true, text: form.topic === 'scope_gap' ? 'Flagged to the owner.' : 'Sent — they were told.' });
  }

  return (
    <details className="ste-card">
      <summary>Ask a question or flag a scope gap</summary>
      <div className="ste-chips" role="group" aria-label="Kind of question">
        {(Object.keys(TOPIC_LABEL) as QuestionTopic[]).map((t) => (
          <button key={t} type="button" className={`ste-chip${form.topic === t ? ' is-on' : ''}`} aria-pressed={form.topic === t}
            onClick={() => set({ topic: t })}>{TOPIC_LABEL[t]}</button>
        ))}
      </div>
      {form.topic === 'scope_gap'
        ? <p className="ste-quiet">A scope gap goes to the owner, who decides who takes the work.</p>
        : (
          <select className="ste-field" aria-label="Who answers" value={form.addresseeOrgId} onChange={(e) => set({ addresseeOrgId: e.target.value })}>
            <option value="">{form.topic === 'design_change' ? 'Who approves it (the architect)…' : 'Who answers…'}</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
      <select className="ste-field" aria-label="About" value={form.taskId} onChange={(e) => set({ taskId: e.target.value })}>
        <option value="">About the whole build</option>
        {tasks.map((t) => <option key={t.id} value={t.id}>Task: {t.name}</option>)}
      </select>
      <textarea className="ste-field" rows={3} maxLength={8000} value={form.body} onChange={(e) => set({ body: e.target.value })}
        placeholder={form.topic === 'scope_gap' ? 'What work nobody holds' : form.topic === 'design_change' ? 'The change you propose and why' : 'Your question'} />
      {message ? <p className={message.ok ? 'ste-ok' : 'ste-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p> : null}
      <div className="btn-row"><button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>Send</button></div>
    </details>
  );
}
