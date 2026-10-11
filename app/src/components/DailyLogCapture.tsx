'use client';

// PRD-10 E-7/E-8 — the phone-first daily-log capture. A foreman on site sets
// who is here and how many, the weather, what was done on which task, any
// issue, and takes photos with the camera (each tagged to a task or a
// location). Photos go up first through the documents flow (reserve → PUT →
// complete, kind = photo); "Send" then posts ONE capture of every entry, each
// with its own client id, so a retry after a dropped connection is absorbed by
// the server instead of doubling the day.
//
// D-14: no offline support. When the browser goes offline the page says so
// and disables sending; nothing is queued locally.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';

import {
  completeSitePhotoAction, reserveSitePhotoAction, sendDailyLogAction,
} from '@/lib/v2/execution-actions';
import { digestSha256, putToTicket } from '@/lib/v2/upload-client';
import {
  OFFLINE_MESSAGE, WEATHER_OPTIONS, captureEntries, dayWords, type CaptureForm,
} from '@/lib/v2/execution-view';
import './site.css';

type Option = { id: string; name: string };
interface Shot {
  key: string; preview: string; state: 'uploading' | 'ready' | 'error'; message?: string;
  documentId: string | null; taskId: string | null; locationId: string | null; caption: string;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

export function DailyLogCapture({
  projectId, today, orgs, tasks, locations,
}: {
  projectId: string;
  today: string;
  orgs: Option[];
  tasks: Option[];
  locations: Option[];
}) {
  const online = useOnline();
  const [date, setDate] = useState(today);
  const [heads, setHeads] = useState<Record<string, string>>({});
  const [weather, setWeather] = useState<string | null>(null);
  const [temp, setTemp] = useState('');
  const [work, setWork] = useState<CaptureForm['work']>([{ taskId: '', note: '', percent: null }]);
  const [issue, setIssue] = useState({ note: '', taskId: '', locationId: '' });
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  // One id per entry for this capture, kept across retries (idempotent server-side).
  const ids = useRef<string[]>([]);
  const camera = useRef<HTMLInputElement>(null);

  const form: CaptureForm = useMemo(() => ({
    presence: orgs.map((o) => ({ orgId: o.id, headcount: heads[o.id] === undefined || heads[o.id] === '' ? null : Number(heads[o.id]) })),
    weather,
    temperatureC: temp === '' ? null : Number(temp),
    work,
    issues: [{ note: issue.note, taskId: issue.taskId || null, locationId: issue.locationId || null }],
    photos: shots.filter((s) => s.state === 'ready' && s.documentId)
      .map((s) => ({ documentId: s.documentId!, taskId: s.taskId, locationId: s.locationId, caption: s.caption })),
  }), [orgs, heads, weather, temp, work, issue, shots]);

  // An edit makes it a different capture: new ids, so a retry never collides.
  useEffect(() => { ids.current = []; }, [form, date]);

  const addPhotos = useCallback(async (list: FileList | null) => {
    if (!list?.length) return;
    for (const file of [...list].slice(0, 10)) {
      const key = `${Date.now()}-${file.name}`;
      const shot: Shot = { key, preview: URL.createObjectURL(file), state: 'uploading', documentId: null, taskId: null, locationId: null, caption: '' };
      setShots((prev) => [...prev, shot]);
      const fail = (message: string) => setShots((prev) => prev.map((s) => (s.key === key ? { ...s, state: 'error', message } : s)));
      try {
        const mime = file.type || 'image/jpeg';
        const { hex, base64 } = await digestSha256(file);
        const reserved = await reserveSitePhotoAction(projectId, { name: file.name || 'photo.jpg', mime, sizeBytes: file.size, sha256: hex });
        if (!reserved.ok) { fail(reserved.message); continue; }
        await putToTicket(reserved.value.uploadUrl, file, mime, base64);
        const done = await completeSitePhotoAction(reserved.value.versionRef);
        if (!done.ok) { fail(done.message); continue; }
        setShots((prev) => prev.map((s) => (s.key === key ? { ...s, state: 'ready', documentId: reserved.value.documentId } : s)));
      } catch {
        fail(navigator.onLine ? 'That photo did not upload. Try again.' : OFFLINE_MESSAGE);
      }
    }
    if (camera.current) camera.current.value = '';
  }, [projectId]);

  const send = useCallback(async () => {
    setBusy(true); setError(null); setSent(null);
    let n = 0;
    const entries = captureEntries(form, () => {
      if (!ids.current[n]) ids.current[n] = crypto.randomUUID();
      return ids.current[n++];
    });
    if (!entries.length) { setBusy(false); setError('Nothing to send yet — add who is on site, the weather, work, an issue or a photo.'); return; }
    const res = await sendDailyLogAction(projectId, date, entries);
    setBusy(false);
    if (!res.ok) { setError(online ? res.message : OFFLINE_MESSAGE); return; }
    ids.current = [];
    setSent(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} on the record for ${dayWords(date)} — ${res.value.headcount_total} on site.`);
    setWork([{ taskId: '', note: '', percent: null }]);
    setIssue({ note: '', taskId: '', locationId: '' });
    setShots([]);
  }, [form, projectId, date, online]);

  const uploading = shots.some((s) => s.state === 'uploading');

  return (
    <>
      <header className="ste-head">
        <h1>Log the day</h1>
        <Link href={`/projects/${projectId}/site?date=${date}`}>See the day</Link>
      </header>
      {!online ? <p className="ste-offline" role="alert">{OFFLINE_MESSAGE}</p> : null}
      {sent ? <p className="ste-ok" role="status">{sent}</p> : null}

      <section className="ste-card">
        <label className="ste-row"><span>Site day</span>
          <input className="ste-field" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 200 }} />
        </label>
      </section>

      <section className="ste-card" aria-label="On site">
        <h2>On site</h2>
        {orgs.length === 0 ? <p className="ste-quiet">No organisations on this build yet.</p> : orgs.map((o) => (
          <div className="ste-row" key={o.id}>
            <label htmlFor={`hc-${o.id}`}>{o.name}</label>
            <input id={`hc-${o.id}`} className="ste-num" type="number" inputMode="numeric" min={0} max={999}
              placeholder="people" value={heads[o.id] ?? ''} onChange={(e) => setHeads((h) => ({ ...h, [o.id]: e.target.value }))} />
          </div>
        ))}
      </section>

      <section className="ste-card" aria-label="Weather">
        <h2>Weather</h2>
        <div className="ste-chips" role="group">
          {WEATHER_OPTIONS.map((w) => (
            <button type="button" key={w.value} className={`ste-chip${weather === w.value ? ' is-on' : ''}`}
              aria-pressed={weather === w.value} onClick={() => setWeather(weather === w.value ? null : w.value)}>{w.label}</button>
          ))}
        </div>
        <label className="ste-row"><span>°C</span>
          <input className="ste-num" type="number" inputMode="numeric" min={-30} max={50} value={temp} onChange={(e) => setTemp(e.target.value)} />
        </label>
      </section>

      <section className="ste-card" aria-label="Work done">
        <h2>Work done</h2>
        {work.map((w, i) => (
          <div key={i} className="ste-row">
            <select className="ste-field" aria-label="Task" value={w.taskId}
              onChange={(e) => setWork((list) => list.map((x, j) => (j === i ? { ...x, taskId: e.target.value } : x)))}>
              <option value="">Task…</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input className="ste-field" placeholder="What was done" value={w.note} maxLength={2000}
              onChange={(e) => setWork((list) => list.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
            <input className="ste-num" type="number" inputMode="numeric" min={0} max={100} placeholder="%" aria-label="Percent done"
              value={w.percent ?? ''} onChange={(e) => setWork((list) => list.map((x, j) => (j === i ? { ...x, percent: e.target.value === '' ? null : Number(e.target.value) } : x)))} />
          </div>
        ))}
        <button type="button" className="btn sm" onClick={() => setWork((list) => [...list, { taskId: '', note: '', percent: null }])}>Add another task</button>
      </section>

      <section className="ste-card" aria-label="Issue">
        <h2>Issue</h2>
        <textarea className="ste-field" rows={2} maxLength={2000} placeholder="Anything wrong on site today?"
          value={issue.note} onChange={(e) => setIssue((x) => ({ ...x, note: e.target.value }))} />
        <div className="ste-row">
          <select className="ste-field" aria-label="Issue task" value={issue.taskId} onChange={(e) => setIssue((x) => ({ ...x, taskId: e.target.value }))}>
            <option value="">Task (optional)</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select className="ste-field" aria-label="Issue location" value={issue.locationId} onChange={(e) => setIssue((x) => ({ ...x, locationId: e.target.value }))}>
            <option value="">Location (optional)</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      </section>

      <section className="ste-card" aria-label="Photos">
        <h2>Photos</h2>
        <label className="ste-camera">
          Take or add photos
          <input ref={camera} type="file" accept="image/*" capture="environment" multiple disabled={!online}
            onChange={(e) => void addPhotos(e.target.files)} />
        </label>
        <div className="ste-photos">
          {shots.map((s) => (
            <div key={s.key} className="ste-photo">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.preview} alt="" />
              <span className={s.state === 'error' ? 'ste-error' : 'ste-quiet'}>
                {s.state === 'uploading' ? 'Uploading…' : s.state === 'ready' ? 'Ready' : s.message}
              </span>
              <select className="ste-field" aria-label="Photo task" value={s.taskId ?? ''}
                onChange={(e) => setShots((list) => list.map((x) => (x.key === s.key ? { ...x, taskId: e.target.value || null } : x)))}>
                <option value="">Task…</option>
                {tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <select className="ste-field" aria-label="Photo location" value={s.locationId ?? ''}
                onChange={(e) => setShots((list) => list.map((x) => (x.key === s.key ? { ...x, locationId: e.target.value || null } : x)))}>
                <option value="">Location…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <input className="ste-field" placeholder="Caption" maxLength={300} value={s.caption}
                onChange={(e) => setShots((list) => list.map((x) => (x.key === s.key ? { ...x, caption: e.target.value } : x)))} />
            </div>
          ))}
        </div>
      </section>

      {error ? <p className="ste-error" role="alert">{error}</p> : null}
      <div className="ste-send">
        <button type="button" className="btn primary" disabled={busy || uploading || !online} onClick={() => void send()}>
          {busy ? 'Sending…' : uploading ? 'Waiting for photos…' : 'Send to the record'}
        </button>
      </div>
    </>
  );
}
