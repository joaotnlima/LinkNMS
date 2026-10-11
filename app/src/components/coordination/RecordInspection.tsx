'use client';

// PRD-12 N-4 — record an inspection against locations and/or tasks: the date,
// quality or safety, a checklist (one line per item; "x " marks a failed one)
// and the findings. Only an invited inspector or a client on the build may —
// the server answers anyone else with the reason.
import { useRef, useState } from 'react';

import { recordInspectionAction } from '@/lib/v2/quality-actions';
import { parseChecklist } from '@/lib/v2/quality-view';

type Option = { id: string; name: string };

export function RecordInspection({ projectId, today, tasks, locations }: {
  projectId: string; today: string; tasks: Option[]; locations: Option[];
}) {
  const [date, setDate] = useState(today);
  const [kind, setKind] = useState<'quality' | 'safety'>('quality');
  const [checklist, setChecklist] = useState('');
  const [findings, setFindings] = useState('');
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [taskId, setTaskId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const clientId = useRef<string | null>(null);

  async function submit() {
    if (!clientId.current) clientId.current = crypto.randomUUID();
    setBusy(true); setMessage(null);
    const res = await recordInspectionAction(projectId, {
      id: clientId.current, date, kind, checklist: parseChecklist(checklist),
      ...(findings.trim() ? { findings: findings.trim() } : {}),
      task_ids: taskId ? [taskId] : [], location_ids: locationIds,
    });
    setBusy(false);
    if (!res.ok) { setMessage({ ok: false, text: res.message }); return; }
    clientId.current = null;
    setChecklist(''); setFindings(''); setLocationIds([]); setTaskId('');
    setMessage({ ok: true, text: 'Inspection recorded.' });
  }

  return (
    <details className="ste-card">
      <summary>Record an inspection</summary>
      <div className="ste-row">
        <input className="ste-field" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 200 }} />
        <div className="ste-chips" role="group" aria-label="Kind">
          {(['quality', 'safety'] as const).map((k) => (
            <button key={k} type="button" className={`ste-chip${kind === k ? ' is-on' : ''}`} aria-pressed={kind === k}
              onClick={() => setKind(k)}>{k === 'safety' ? 'Safety' : 'Quality'}</button>
          ))}
        </div>
      </div>
      <fieldset className="ste-chips" aria-label="Locations inspected">
        {locations.map((l) => (
          <label key={l.id} className={`ste-chip${locationIds.includes(l.id) ? ' is-on' : ''}`}>
            <input type="checkbox" checked={locationIds.includes(l.id)} style={{ marginRight: 6 }}
              onChange={(e) => setLocationIds((ids) => (e.target.checked ? [...ids, l.id] : ids.filter((x) => x !== l.id)))} />
            {l.name}
          </label>
        ))}
      </fieldset>
      <select className="ste-field" aria-label="Task" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
        <option value="">Task (optional)</option>
        {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <textarea className="ste-field" rows={4} value={checklist} onChange={(e) => setChecklist(e.target.value)}
        placeholder={'Checklist — one item per line; start with "x " when it failed\nAndaimes fixos\nx Guarda-corpos no piso 2'} />
      <textarea className="ste-field" rows={2} maxLength={4000} value={findings} onChange={(e) => setFindings(e.target.value)} placeholder="Findings" />
      {message ? <p className={message.ok ? 'ste-ok' : 'ste-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p> : null}
      <div className="btn-row"><button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>Record</button></div>
    </details>
  );
}
