'use client';

// Upload a new .ifc of the build's model (PRD-07 M-18; board F10 "Upload a new
// version"). Before anything is sent, the new file is read in the browser and
// compared with the current one BY GLOBALID: linked / pinned elements missing
// from it are listed for relinking (nothing is dropped silently — the links
// stay on the record, keyed by GlobalId), and an export that regenerated its
// GlobalIds ("all removed, all added") is called out. Then reserve → PUT →
// complete, the same protocol as every document. The server lets only the
// model's author (or, for a build's first model, any participant) through.
import { useRef, useState } from 'react';

import { completeModelVersionAction, reserveModelVersionAction } from '@/lib/v2/model-actions';
import { humanSize, uploadCheck, type V2ElementLink, type V2ElementPin } from '@/lib/v2/model-view';
import { digestSha256, putToTicket } from '@/lib/v2/upload-client';
import { readIfcIndex } from './ifc-index';

const MAX_BYTES = 100 * 1024 * 1024;

export function ModelUpload({
  projectId, current, links, pins, nextVersion, onDone,
}: {
  projectId: string;
  /** The bytes of the current version (for the GlobalId check), or null for a first model. */
  current: Uint8Array | null;
  links: V2ElementLink[];
  pins: V2ElementPin[];
  nextVersion: number;
  onDone: () => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<ReturnType<typeof uploadCheck> | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (f: File | null) => {
    setFile(null); setCheck(null); setError(null);
    if (!f) return;
    if (!/\.ifc$/i.test(f.name)) { setError('That is not an IFC file. Upload a .ifc model.'); return; }
    if (f.size > MAX_BYTES) { setError(`That model is ${humanSize(f.size)} — the limit is 100 MB.`); return; }
    setBusy('Reading the new file…');
    try {
      const next = await readIfcIndex(new Uint8Array(await f.arrayBuffer()));
      const cur = current ? await readIfcIndex(current) : null;
      setCheck(uploadCheck(cur, next, links, pins));
      setFile(f);
    } catch {
      setError('This file could not be read as IFC.');
    } finally {
      setBusy(null);
    }
  };

  const upload = async () => {
    if (!file) return;
    setBusy('Uploading…'); setError(null);
    try {
      const { hex, base64 } = await digestSha256(file);
      const reserved = await reserveModelVersionAction(projectId, { name: file.name, sizeBytes: file.size, sha256: hex }, note || null);
      if (!reserved.ok) { setError(reserved.message); return; }
      await putToTicket(reserved.value.uploadUrl, file, 'application/x-step', base64);
      const done = await completeModelVersionAction(reserved.value.versionRef);
      if (!done.ok) { setError(done.message); return; }
      setFile(null); setCheck(null); setNote('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That model did not upload. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mdl-upload">
      <input ref={input} type="file" accept=".ifc" hidden onChange={(e) => { void pick(e.target.files?.[0] ?? null); e.target.value = ''; }} />
      <button type="button" className="btn sm" onClick={() => input.current?.click()} disabled={Boolean(busy)}>
        {nextVersion === 1 ? 'Upload the model (.ifc)' : 'Upload a new version'}
      </button>
      <p className="mdl-note">An .ifc exported from Revit, ArchiCAD or any IFC tool · up to 100 MB · becomes v{nextVersion}.
        {nextVersion > 1 ? ' Task links and issues carry over to the new file by element GlobalId.' : ''}</p>
      {busy ? <p className="mdl-note" role="status">{busy}</p> : null}
      {check && file ? (
        <div className="mdl-form">
          <b>{file.name} · {humanSize(file.size)}</b>
          {check.regenerated ? (
            <p className="mdl-warn">This export shares almost no element GlobalId with the current version — it looks like the tool regenerated them (“all removed, all added”). Links and issues will not find their elements. Re-export keeping GlobalIds if you can.</p>
          ) : null}
          {check.unmatched.length ? (
            <div className="mdl-warn">
              {check.unmatched.length} linked or pinned element{check.unmatched.length === 1 ? ' is' : 's are'} not in the new file — they stay on the record for relinking:
              <ul className="mdl-list mdl-mono">{check.unmatched.slice(0, 30).map((g) => <li key={g}>{g}</li>)}</ul>
              {check.unmatched.length > 30 ? <span>…and {check.unmatched.length - 30} more.</span> : null}
            </div>
          ) : current ? <p className="mdl-note">Every linked and pinned element is in the new file.</p> : null}
          <label>What changed <span className="mdl-note">(optional)</span>
            <textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="mdl-row">
            <button type="button" className="btn sm" onClick={() => { setFile(null); setCheck(null); }}>Cancel</button>
            <button type="button" className="btn sm primary" onClick={upload} disabled={Boolean(busy)}>Save as v{nextVersion}</button>
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="mdl-err">{error}</p> : null}
    </div>
  );
}
