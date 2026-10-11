'use client';

// PRD-12 N-6 — meeting minutes (ata de obra): write a draft (date, the
// organisations that attended, one item per line), circulate it, and each
// attending organisation acknowledges. The server says who may do which.
import { useRef, useState } from 'react';

import { createMinuteAction, moveMinuteAction } from '@/lib/v2/questions-actions';
import { minuteBody, type MinuteForm } from '@/lib/v2/questions-view';

type Option = { id: string; name: string };

export function NewMinute({ projectId, today, orgs }: { projectId: string; today: string; orgs: Option[] }) {
  const [form, setForm] = useState<MinuteForm>({ date: today, attendees: [], items: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const clientId = useRef<string | null>(null);
  const set = (patch: Partial<MinuteForm>) => { clientId.current = null; setForm((f) => ({ ...f, ...patch })); };

  async function submit() {
    if (!clientId.current) clientId.current = crypto.randomUUID();
    const built = minuteBody(form, clientId.current);
    if (!built.ok) { setMessage({ ok: false, text: built.message }); return; }
    setBusy(true); setMessage(null);
    const res = await createMinuteAction(projectId, built.body);
    setBusy(false);
    if (!res.ok) { setMessage({ ok: false, text: res.message }); return; }
    clientId.current = null;
    setForm({ date: today, attendees: [], items: '' });
    setMessage({ ok: true, text: 'Draft saved — circulate it when it is ready.' });
  }

  return (
    <details className="ste-card">
      <summary>Write the minutes of a meeting</summary>
      <input className="ste-field" type="date" max={today} value={form.date} onChange={(e) => set({ date: e.target.value })} style={{ maxWidth: 200 }} />
      <fieldset className="ste-chips" aria-label="Who attended">
        {orgs.map((o) => (
          <label key={o.id} className={`ste-chip${form.attendees.includes(o.id) ? ' is-on' : ''}`}>
            <input type="checkbox" checked={form.attendees.includes(o.id)} style={{ marginRight: 6 }}
              onChange={(e) => set({ attendees: e.target.checked ? [...form.attendees, o.id] : form.attendees.filter((x) => x !== o.id) })} />
            {o.name}
          </label>
        ))}
      </fieldset>
      <textarea className="ste-field" rows={4} value={form.items} onChange={(e) => set({ items: e.target.value })}
        placeholder={'What was agreed — one item per line\nBetonagem da laje na sexta\nAndaimes retirados até dia 20'} />
      {message ? <p className={message.ok ? 'ste-ok' : 'ste-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p> : null}
      <div className="btn-row"><button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>Save draft</button></div>
    </details>
  );
}

export function MinuteActions({ projectId, minuteId, actions }: {
  projectId: string; minuteId: string; actions: Array<'circulate' | 'acknowledge'>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!actions.length) return null;
  async function go(action: 'circulate' | 'acknowledge') {
    setBusy(true); setError(null);
    const res = await moveMinuteAction(projectId, minuteId, action);
    setBusy(false);
    if (!res.ok) setError(res.message);
  }
  return (
    <div className="crd-act">
      {actions.map((a) => (
        <button key={a} type="button" className="btn primary" disabled={busy} onClick={() => void go(a)}>
          {a === 'circulate' ? 'Circulate to the attendees' : 'Acknowledge'}
        </button>
      ))}
      {error ? <p className="ste-error" role="alert">{error}</p> : null}
    </div>
  );
}
