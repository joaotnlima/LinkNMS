'use client';

// Upload a new .ifc of the build's model (PRD-07 M-18; board F10 "Upload a new
// version"). The browser reads the new file's element GlobalIds and sends them
// with the reservation; when the upload completes the SERVER compares them with
// the record and the previous upload (`upload_check`): linked / pinned
// elements missing from the file are listed for relinking (nothing is dropped —
// the links stay on the record, keyed by GlobalId), and an export that
// regenerated its GlobalIds is called out. Reserve → PUT → complete, the same
// protocol as every document. The server lets only the model's author (or, for
// a build's first model, any participant) through.
import { useRef, useState } from 'react';

import { completeModelVersionAction, reserveModelVersionAction } from '@/lib/v2/model-actions';
import { humanSize, type V2ModelUploadCheck } from '@/lib/v2/model-view';
import { digestSha256, putToTicket } from '@/lib/v2/upload-client';
import { readIfcIndex } from './ifc-index';

const MAX_BYTES = 100 * 1024 * 1024;

export function ModelUpload({
  projectId, check, nextVersion, onDone,
}: {
  projectId: string;
  /** The server's check of the latest upload (null: none yet, or no GlobalIds declared). */
  check: V2ModelUploadCheck | null;
  nextVersion: number;
  onDone: () => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [globalIds, setGlobalIds] = useState<string[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (f: File | null) => {
    setFile(null); setGlobalIds(null); setError(null);
    if (!f) return;
    if (!/\.ifc$/i.test(f.name)) { setError('That is not an IFC file. Upload a .ifc model.'); return; }
    if (f.size > MAX_BYTES) { setError(`That model is ${humanSize(f.size)} — the limit is 100 MB.`); return; }
    setBusy('Reading the new file…');
    try {
      // Extraction only: the comparison with the record is the server's.
      const next = await readIfcIndex(new Uint8Array(await f.arrayBuffer()));
      setGlobalIds([...next.keys()]);
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
      const reserved = await reserveModelVersionAction(projectId, { name: file.name, sizeBytes: file.size, sha256: hex }, note || null, globalIds);
      if (!reserved.ok) { setError(reserved.message); return; }
      await putToTicket(reserved.value.uploadUrl, file, 'application/x-step', base64);
      const done = await completeModelVersionAction(reserved.value.versionRef);
      if (!done.ok) { setError(done.message); return; }
      setFile(null); setGlobalIds(null); setNote('');
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
      {check && !file && (check.regenerated || check.unmatched_global_ids.length) ? (
        <div className="mdl-warn" role="status">
          <b>v{check.version_no}</b>
          {check.regenerated ? (
            <p>This export shares almost no element GlobalId with the version before it — the tool looks to have regenerated them (“all removed, all added”). Links and issues will not find their elements. Re-export keeping GlobalIds if you can.</p>
          ) : null}
          {check.unmatched_global_ids.length ? (
            <>
              {check.unmatched_global_ids.length} linked or pinned element{check.unmatched_global_ids.length === 1 ? ' is' : 's are'} not in this file — they stay on the record for relinking:
              <ul className="mdl-list mdl-mono">{check.unmatched_global_ids.slice(0, 30).map((g) => <li key={g}>{g}</li>)}</ul>
              {check.unmatched_global_ids.length > 30 ? <span>…and {check.unmatched_global_ids.length - 30} more.</span> : null}
            </>
          ) : null}
        </div>
      ) : null}
      {file ? (
        <div className="mdl-form">
          <b>{file.name} · {humanSize(file.size)}{globalIds ? ` · ${globalIds.length} elements` : ''}</b>
          <p className="mdl-note">After the upload the server checks it against the record: elements that links or issues point at but the new file lacks are listed for relinking.</p>
          <label>What changed <span className="mdl-note">(optional)</span>
            <textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="mdl-row">
            <button type="button" className="btn sm" onClick={() => { setFile(null); setGlobalIds(null); }}>Cancel</button>
            <button type="button" className="btn sm primary" onClick={upload} disabled={Boolean(busy)}>Save as v{nextVersion}</button>
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="mdl-err">{error}</p> : null}
    </div>
  );
}
