// /share/[token] — what the holder of a share link sees, with no account (PRD-12
// N-12, flow D21): the build, who it was shared with, until when, and the
// shared documents only — each opened in the browser (PDF, images) or
// downloaded, read-only. Every visit and download is logged server-side.
//
// A server component dispatching the `security: []` read in-process
// (lib/v2/share-links.ts), like /rfp/{token}: the token never becomes an API wire
// URL. noindex here and `no-referrer` in next.config; /share is not in the
// middleware's protected routes — nothing here needs, or grants, a session.
import type { Metadata } from 'next';

import { Mark } from '@/components/icons';
import { loadSharedV2 } from '@/lib/v2/share-links';
import { opensInline, sharedDocumentPath, sizeWords } from '@/lib/v2/share-links-view';
import '@/components/site.css';
import '@/components/coordination/coordination.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Shared documents · LinkNMS',
  robots: { index: false, follow: false, nosnippet: true, noarchive: true },
};

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const load = await loadSharedV2(token);

  return (
    <main className="ste-page">
      <header className="ste-head"><span className="crd-meta"><Mark /> <strong>LinkNMS</strong> · shared documents</span></header>
      {load.state === 'ready' ? (
        <>
          <section className="ste-card">
            <h1>{load.view.project_name}</h1>
            <p className="crd-meta">
              <span>Shared with {load.view.audience}</span>
              <span>Open until {load.view.expires_at.slice(0, 10)}</span>
            </p>
          </section>
          {load.view.documents.length === 0 ? <p className="ste-quiet">No documents are available through this link any more.</p> : (
            <ul className="crd-list">
              {load.view.documents.map((d) => (
                <li key={d.id} className="crd-item">
                  <strong>{d.title}</strong>
                  <span className="crd-meta">
                    <span>Version {d.version_no}</span>
                    {d.size_bytes != null ? <span>{sizeWords(d.size_bytes)}</span> : null}
                    {d.uploaded_at ? <span>{d.uploaded_at.slice(0, 10)}</span> : null}
                    {d.sha256 ? <span title="The file’s fingerprint on the record">sha256 {d.sha256.slice(0, 12)}…</span> : null}
                  </span>
                  <span className="crd-act">
                    {opensInline(d) ? <a className="btn" href={sharedDocumentPath(token, d.id, true)} target="_blank" rel="noreferrer">Open</a> : null}
                    <a className="btn primary" href={sharedDocumentPath(token, d.id)}>Download</a>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <section className="ste-card" aria-live="polite">
          <h1>{load.state === 'closed' ? (load.reason === 'revoked' ? 'This link was revoked.' : 'This link has expired.') : load.state === 'dead' ? 'This link is not valid.' : 'The documents could not be loaded.'}</h1>
          <p>
            {load.state === 'closed' && load.reason === 'expired' && load.expiresAt ? `It was open until ${load.expiresAt.slice(0, 10)}. ` : ''}
            {load.state === 'error' ? 'Try again in a moment.' : 'Ask whoever sent it for a new link.'}
          </p>
        </section>
      )}
      <p className="ste-quiet">You reached this page from a link shared with you. No LinkNMS account is needed; every access is recorded.</p>
    </main>
  );
}
