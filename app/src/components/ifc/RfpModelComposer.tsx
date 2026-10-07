'use client';

// The owner's attach / replace / remove control for the RFP's BIM model
// (LINA-409 / doc 24). Lives in the draft composer — the model can only change
// while the RFP is a draft (the BE refuses otherwise), so this never renders
// once published. One model per RFP (Phase 1): attaching a second replaces the
// first as a new version.
//
// ── BUNDLE DISCIPLINE (same as PortfolioUpload) ───────────────────────────────
// A client island. The two JSON steps (reserve, complete) cross to the server
// through the actions in `procurement-actions.ts`; the one browser→R2 step (the
// presigned PUT of the raw bytes) runs here via `upload-client.ts`, so the file
// never passes through our server. web-ifc/Three.js enter the bundle only
// through <OwnerModelViewer>, which is itself `ssr:false`-dynamic.
import { useEffect, useRef, useState } from 'react';

import {
  reserveRfpModelAction,
  completeRfpModelAction,
  removeRfpModelAction,
} from '../procurement-actions';
import { digestSha256, putToTicket } from '@/lib/v2/upload-client';
import type { V2Model } from '@/lib/v2/tendering-view';

import OwnerModelViewer from './OwnerModelViewer';

// IFC carries no agreed browser mime; the BE normalises every model to this on
// the wire and signs the presigned PUT for it, so the browser PUT must send it
// verbatim (doc 24 / domain rfp-model.mjs MODEL_MIME).
const MODEL_MIME = 'application/x-step';
const MAX_MODEL_BYTES = 100 * 1024 * 1024; // 100 MB — doc 24 decision 6.

function isIfc(name: string): boolean {
  return /\.ifc$/i.test(name.trim());
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export default function RfpModelComposer({
  rfpId, model, disabled = false,
}: {
  rfpId: string;
  /** The currently-attached model from the RFP package projection, or null. */
  model: V2Model | null;
  disabled?: boolean;
}) {
  // Local truth for immediate feedback: seeded from the projection, advanced on
  // attach/remove without a round trip (the persisted truth rides getRfp on the
  // next composer reload).
  const [current, setCurrent] = useState<V2Model | null>(model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Re-sync when the package projection resolves (package loads async after the
  // composer first paints) or a different RFP mounts this control.
  useEffect(() => { setCurrent(model); }, [model?.documentId, model?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = () => { setError(null); inputRef.current?.click(); };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Let the same file be picked again after a remove/replace.
    e.target.value = '';
    if (!file) return;

    if (!isIfc(file.name)) {
      setError('That is not an IFC file. Attach a .ifc model.');
      return;
    }
    if (file.size > MAX_MODEL_BYTES) {
      setError(`That model is ${humanSize(file.size)} — the limit is 100 MB.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { hex, base64 } = await digestSha256(file);
      const reserved = await reserveRfpModelAction(rfpId, {
        name: file.name, mime: MODEL_MIME, sizeBytes: file.size, sha256: hex,
      });
      if (!reserved.ok) { setError(reserved.message); return; }

      await putToTicket(reserved.data.uploadUrl, file, MODEL_MIME, base64);

      const done = await completeRfpModelAction(rfpId, reserved.data.documentId);
      if (!done.ok) { setError(done.message); return; }

      setCurrent({
        documentId: reserved.data.documentId,
        version: reserved.data.version,
        fileName: file.name,
        mime: MODEL_MIME,
        sizeBytes: file.size,
        sha256: hex,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That model did not upload. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    const res = await removeRfpModelAction(rfpId, current.documentId);
    setBusy(false);
    if (!res.ok) { setError(res.message); return; }
    setCurrent(null);
  };

  return (
    <div className="prc-field">
      <span className="prc-label">3D model (IFC)</span>
      <p className="prc-quiet">
        Attach the building model bidders view before pricing — read-only, in the browser, no desktop
        BIM needed. IFC only, up to 100 MB.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".ifc"
        style={{ display: 'none' }}
        onChange={onFile}
        disabled={disabled || busy}
      />

      {current ? (
        <>
          <div className="prc-row" style={{ alignItems: 'center', gap: 10 }}>
            <button type="button" className="btn" onClick={pick} disabled={disabled || busy}>
              {busy ? 'Working…' : 'Replace'}
            </button>
            <button type="button" className="btn" onClick={remove} disabled={disabled || busy}>
              Remove
            </button>
          </div>
          <div style={{ marginTop: 10 }}>
            <OwnerModelViewer
              key={`${current.documentId}:${current.version}`}
              rfpId={rfpId}
              documentId={current.documentId}
              fileName={current.fileName}
              sizeBytes={current.sizeBytes}
            />
          </div>
        </>
      ) : (
        <div className="prc-row">
          <button type="button" className="btn" onClick={pick} disabled={disabled || busy}>
            {busy ? 'Uploading…' : 'Attach .ifc model'}
          </button>
        </div>
      )}

      {error ? <p className="prc-reject" role="alert">{error}</p> : null}
    </div>
  );
}
