'use client';

// PRD-12 N-3 — raise a non-conformity on site: what is wrong, how bad, where
// (a location and/or a task), who should fix it, and photos from the camera.
// Photos go up first through the documents flow (the same reserve → PUT →
// complete the daily log uses, kind = photo); "Raise" then sends one request
// with a client id, so a retry after a dropped connection is absorbed.
import { useRef, useState } from 'react';

import { completeSitePhotoAction, reserveSitePhotoAction } from '@/lib/v2/execution-actions';
import { digestSha256, putToTicket } from '@/lib/v2/upload-client';
import { raiseNcAction } from '@/lib/v2/quality-actions';
import { SEVERITIES, raiseBody, type RaiseForm } from '@/lib/v2/quality-view';

type Option = { id: string; name: string };
type Shot = { key: string; name: string; state: 'uploading' | 'ready' | 'error'; documentId: string | null };

const EMPTY: RaiseForm = { description: '', severity: 'major', kind: 'quality', taskId: '', locationId: '', assignedToOrgId: '', photoDocumentIds: [] };

export function RaiseNonConformity({ projectId, orgs, tasks, locations }: {
  projectId: string; orgs: Option[]; tasks: Option[]; locations: Option[];
}) {
  const [form, setForm] = useState<RaiseForm>(EMPTY);
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const clientId = useRef<string | null>(null);
  const set = (patch: Partial<RaiseForm>) => { clientId.current = null; setForm((f) => ({ ...f, ...patch })); };

  async function addPhotos(list: FileList | null) {
    for (const file of [...(list ?? [])].slice(0, 6)) {
      const key = `${Date.now()}-${file.name}`;
      setShots((s) => [...s, { key, name: file.name || 'photo', state: 'uploading', documentId: null }]);
      const mark = (patch: Partial<Shot>) => setShots((s) => s.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      try {
        const mime = file.type || 'image/jpeg';
        const { hex, base64 } = await digestSha256(file);
        const reserved = await reserveSitePhotoAction(projectId, { name: file.name || 'photo.jpg', mime, sizeBytes: file.size, sha256: hex });
        if (!reserved.ok) { mark({ state: 'error' }); continue; }
        await putToTicket(reserved.value.uploadUrl, file, mime, base64);
        const done = await completeSitePhotoAction(reserved.value.versionRef);
        mark(done.ok ? { state: 'ready', documentId: reserved.value.documentId } : { state: 'error' });
      } catch {
        mark({ state: 'error' });
      }
    }
    clientId.current = null;
  }

  async function submit() {
    setMessage(null);
    if (!clientId.current) clientId.current = crypto.randomUUID();
    const photos = shots.filter((s) => s.state === 'ready' && s.documentId).map((s) => s.documentId!);
    const built = raiseBody({ ...form, photoDocumentIds: photos }, clientId.current);
    if (!built.ok) { setMessage({ ok: false, text: built.message }); return; }
    setBusy(true);
    const res = await raiseNcAction(projectId, built.body);
    setBusy(false);
    if (!res.ok) { setMessage({ ok: false, text: res.message }); return; }
    clientId.current = null;
    setForm(EMPTY);
    setShots([]);
    setMessage({ ok: true, text: 'Raised — it is on the record and the organisation named was told.' });
  }

  const uploading = shots.some((s) => s.state === 'uploading');
  return (
    <section className="ste-card" aria-label="Raise a non-conformity">
      <h2>Raise a non-conformity</h2>
      <textarea className="ste-field" rows={3} maxLength={4000} placeholder="What is wrong?" value={form.description}
        onChange={(e) => set({ description: e.target.value })} />
      <div className="ste-row">
        <div className="ste-chips" role="group" aria-label="Severity">
          {SEVERITIES.map((s) => (
            <button key={s} type="button" className={`ste-chip${form.severity === s ? ' is-on' : ''}`} aria-pressed={form.severity === s}
              onClick={() => set({ severity: s })}>{s}</button>
          ))}
        </div>
        <div className="ste-chips" role="group" aria-label="Kind">
          {(['quality', 'safety'] as const).map((k) => (
            <button key={k} type="button" className={`ste-chip${form.kind === k ? ' is-on' : ''}`} aria-pressed={form.kind === k}
              onClick={() => set({ kind: k })}>{k === 'safety' ? 'Safety' : 'Quality'}</button>
          ))}
        </div>
      </div>
      <div className="ste-row">
        <select className="ste-field" aria-label="Location" value={form.locationId} onChange={(e) => set({ locationId: e.target.value })}>
          <option value="">Location (optional)</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select className="ste-field" aria-label="Task" value={form.taskId} onChange={(e) => set({ taskId: e.target.value })}>
          <option value="">Task (optional)</option>
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select className="ste-field" aria-label="Who fixes it" value={form.assignedToOrgId} onChange={(e) => set({ assignedToOrgId: e.target.value })}>
          <option value="">Who fixes it (assign later)</option>
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      <label className="ste-camera">
        Take or add photos
        <input type="file" accept="image/*" capture="environment" multiple onChange={(e) => void addPhotos(e.target.files)} />
      </label>
      {shots.length ? (
        <ul className="ste-log">
          {shots.map((s) => <li key={s.key}>{s.name} — {s.state === 'uploading' ? 'uploading…' : s.state === 'ready' ? 'ready' : 'did not upload'}</li>)}
        </ul>
      ) : null}
      {message ? <p className={message.ok ? 'ste-ok' : 'ste-error'} role={message.ok ? 'status' : 'alert'}>{message.text}</p> : null}
      <div className="btn-row">
        <button type="button" className="btn primary" disabled={busy || uploading} onClick={() => void submit()}>
          {busy ? 'Raising…' : uploading ? 'Waiting for photos…' : 'Raise'}
        </button>
      </div>
    </section>
  );
}
