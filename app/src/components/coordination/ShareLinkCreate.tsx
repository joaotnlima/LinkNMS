'use client';

// PRD-12 N-12 (flow D21) — the owner makes a scoped, expiring link for someone
// with no account (the licensing authority): who it is for, which of the
// build's files, until when. The link is shown ONCE — only its hash is kept.
import { useState } from 'react';

import { createShareLinkAction, revokeShareLinkAction } from '@/lib/v2/share-links-actions';
import { shareBody, type ShareForm } from '@/lib/v2/share-links-view';

type Option = { id: string; name: string };

export function ShareLinkCreate({ projectId, today, defaultExpiry, maxExpiry, files }: {
  /** The latest day the server accepts (listShareLinks max_expires_at) — its limit, not ours. */
  projectId: string; today: string; defaultExpiry: string; maxExpiry: string | null; files: Option[];
}) {
  const [form, setForm] = useState<ShareForm>({ audience: '', expiresOn: defaultExpiry, documentIds: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  async function submit() {
    const built = shareBody(form, today);
    if (!built.ok) { setError(built.message); return; }
    setBusy(true); setError(null);
    const res = await createShareLinkAction(projectId, built.body);
    setBusy(false);
    if (!res.ok) { setError(res.message); return; }
    setUrl(res.url);
    setForm({ audience: '', expiresOn: defaultExpiry, documentIds: [] });
  }

  return (
    <section className="ste-card" aria-label="New share link">
      <h2>Share documents with someone without an account</h2>
      {url ? (
        <div className="ste-ok" role="status">
          <p>Copy this link now — it is shown only once.</p>
          <input className="ste-field" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
          <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(url)}>Copy</button>
        </div>
      ) : null}
      <input className="ste-field" maxLength={200} placeholder="Who it is for — e.g. Câmara Municipal da Maia" value={form.audience}
        onChange={(e) => setForm((f) => ({ ...f, audience: e.target.value }))} />
      <label className="ste-row"><span>Open until</span>
        <input className="ste-field" type="date" min={today} max={maxExpiry ?? undefined} value={form.expiresOn} style={{ maxWidth: 200 }}
          onChange={(e) => setForm((f) => ({ ...f, expiresOn: e.target.value }))} />
      </label>
      {files.length === 0 ? <p className="ste-quiet">No files on this build yet.</p> : (
        <fieldset className="crd-list" aria-label="Documents to share">
          {files.map((f) => (
            <label key={f.id} className="ste-row">
              <input type="checkbox" checked={form.documentIds.includes(f.id)}
                onChange={(e) => setForm((s) => ({ ...s, documentIds: e.target.checked ? [...s.documentIds, f.id] : s.documentIds.filter((x) => x !== f.id) }))} />
              <span>{f.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      {error ? <p className="ste-error" role="alert">{error}</p> : null}
      <div className="btn-row"><button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>Create link</button></div>
    </section>
  );
}

export function RevokeShareLink({ projectId, linkId }: { projectId: string; linkId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="crd-act">
      <button type="button" className="btn reject" disabled={busy} onClick={async () => {
        if (!window.confirm('Revoke this link? Whoever holds it will no longer open the documents.')) return;
        setBusy(true);
        const res = await revokeShareLinkAction(projectId, linkId);
        setBusy(false);
        if (!res.ok) setError(res.message);
      }}>Revoke</button>
      {error ? <span className="ste-error" role="alert">{error}</span> : null}
    </span>
  );
}
