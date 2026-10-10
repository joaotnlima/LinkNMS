'use client';

// ── Record an emailed bid (issuer types in an off-platform answer) ───────────
// The issuer logs a bid that arrived by email/phone against an invited lane. It
// needs at least one document (the bidder's PDFs) — uploaded to R2 through the
// reserve → PUT → complete protocol, scoped to this proposal — plus a total; the
// duration, start, validity and conditions are optional. On success the lane
// moves invited → submitted (channel = email) and joins the comparison.

import { useState } from 'react';

import {
  completeProposalDocumentAction, recordOfflineAction, reserveProposalDocumentAction,
} from '../procurement-actions';
import { eurosToCents } from '@/lib/v2/tendering-view';
import { digestSha256, putToTicket } from '@/lib/v2/upload-client';
import '../procurement.css';

export function RecordOfflineForm({
  proposalId, onCancel, onRecorded, onError,
}: {
  proposalId: string;
  onCancel: () => void;
  onRecorded: () => void;
  onError: (msg: string | null) => void;
}) {
  const [documents, setDocuments] = useState<{ id: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [totalEuros, setTotalEuros] = useState('');
  const [durationWd, setDurationWd] = useState('');
  const [start, setStart] = useState('');
  const [validityUntil, setValidityUntil] = useState('');
  const [conditions, setConditions] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const cents = eurosToCents(totalEuros);
  const blocked = documents.length === 0
    ? 'Attach at least one document from the bid.'
    : cents === null ? 'Enter the total, e.g. 180000.'
      : null;

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setLocalError(null);
    try {
      for (const file of Array.from(files)) {
        const mime = file.type || 'application/octet-stream';
        const { hex, base64 } = await digestSha256(file);
        const reserve = await reserveProposalDocumentAction(proposalId, {
          name: file.name, mime, sizeBytes: file.size, sha256: hex,
        });
        if (!reserve.ok) { setLocalError(reserve.message); break; }
        await putToTicket(reserve.data.uploadUrl, file, mime, base64);
        const done = await completeProposalDocumentAction(reserve.data.versionRef);
        if (!done.ok) { setLocalError(done.message); break; }
        const { documentId } = reserve.data;
        setDocuments((prev) => [...prev, { id: documentId, name: file.name }]);
      }
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'That file did not upload. Try again.');
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (blocked || cents === null) { setLocalError(blocked); return; }
    setBusy(true);
    onError(null);
    setLocalError(null);
    const dur = durationWd.trim() ? Math.round(Number(durationWd)) : undefined;
    const res = await recordOfflineAction(proposalId, {
      documentIds: documents.map((d) => d.id),
      totalCents: cents,
      ...(dur !== undefined && Number.isFinite(dur) ? { durationWd: dur } : {}),
      ...(start ? { start } : {}),
      ...(validityUntil ? { validityUntil } : {}),
      ...(conditions.trim() ? { conditions: conditions.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) { onError(res.message); return; }
    onRecorded();
  };

  return (
    <div className="prc-offline" role="group" aria-label="Record an emailed bid">
      {localError ? <p role="alert" className="prc-reject">{localError}</p> : null}

      {/* ── Documents (at least one) ─────────────────────────────────────── */}
      <div className="prc-field">
        <span className="prc-label">The bid documents</span>
        {documents.length > 0 ? (
          <ul className="prc-doc-list">
            {documents.map((d) => (
              <li key={d.id} className="prc-doc">
                <span className="prc-doc-name">{d.name}</span>
                <button
                  type="button"
                  className="prc-remove"
                  disabled={busy}
                  onClick={() => setDocuments((prev) => prev.filter((x) => x.id !== d.id))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="prc-quiet">The PDF or images the contractor sent. At least one.</p>
        )}
        <label className={`btn tws-upload${uploading ? ' is-busy' : ''}`}>
          {uploading ? 'Uploading…' : 'Attach a file'}
          <input
            type="file"
            multiple
            className="prc-file-input"
            disabled={uploading || busy}
            onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }}
          />
        </label>
      </div>

      <div className="prc-row">
        <div className="prc-field">
          <label className="prc-label" htmlFor={`prc-off-total-${proposalId}`}>Total (EUR)</label>
          <input
            id={`prc-off-total-${proposalId}`}
            className="prc-line"
            inputMode="decimal"
            placeholder="180000"
            value={totalEuros}
            onChange={(e) => setTotalEuros(e.target.value)}
          />
        </div>
        <div className="prc-field">
          <label className="prc-label" htmlFor={`prc-off-dur-${proposalId}`}>Duration (working days)</label>
          <input
            id={`prc-off-dur-${proposalId}`}
            className="prc-line"
            inputMode="numeric"
            placeholder="optional"
            value={durationWd}
            onChange={(e) => setDurationWd(e.target.value)}
          />
        </div>
      </div>

      <div className="prc-row">
        <div className="prc-field">
          <label className="prc-label" htmlFor={`prc-off-start-${proposalId}`}>Can start</label>
          <input
            id={`prc-off-start-${proposalId}`}
            className="prc-line"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className="prc-field">
          <label className="prc-label" htmlFor={`prc-off-val-${proposalId}`}>Valid until</label>
          <input
            id={`prc-off-val-${proposalId}`}
            className="prc-line"
            type="date"
            value={validityUntil}
            onChange={(e) => setValidityUntil(e.target.value)}
          />
        </div>
      </div>

      <div className="prc-field">
        <label className="prc-label" htmlFor={`prc-off-cond-${proposalId}`}>Conditions (optional)</label>
        <textarea
          id={`prc-off-cond-${proposalId}`}
          className="prc-input"
          value={conditions}
          maxLength={2000}
          placeholder="Anything the contractor noted alongside the price."
          onChange={(e) => setConditions(e.target.value)}
        />
      </div>

      <div className="prc-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || uploading || blocked !== null}
          onClick={submit}
        >
          {busy ? 'Recording…' : 'Record the bid'}
        </button>
        {blocked && !uploading ? <span className="prc-quiet">{blocked}</span> : null}
      </div>
    </div>
  );
}
