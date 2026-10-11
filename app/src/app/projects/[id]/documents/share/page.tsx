// Share links — `/projects/{id}/documents/share` (PRD-12 N-12, flow D21). The
// owner's scoped, expiring links for someone with no account (the licensing
// authority): make one from the build's files, see each link's state and use,
// revoke it, and read its access log (`?link=`). Owner-only on the server; any
// other viewer gets the sentence.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2 } from '@/lib/v2/record';
import { V2Error } from '@/lib/v2/client';
import { fetchProjectFiles } from '@/lib/v2/task-files';
import { listShareLinkAccessesV2, listShareLinksV2 } from '@/lib/v2/share-links';
import { accessWords, statusWords, usageWords, type V2ShareLink, type V2ShareLinkAccess } from '@/lib/v2/share-links-view';
import { RevokeShareLink, ShareLinkCreate } from '@/components/coordination/ShareLinkCreate';
import '@/components/site.css';
import '@/components/coordination/coordination.css';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ShareLinksPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ link?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/documents/share`);
  const sp = await searchParams;
  const record = await getRecordV2(id);
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  let links: V2ShareLink[] = [];
  let refused: string | null = null;
  try {
    links = await listShareLinksV2(id);
  } catch (err) {
    if (!(err instanceof V2Error)) throw err;
    refused = err.status === 403 ? 'Only the owner of this build shares its documents.' : (err.detail ?? 'Share links could not be loaded.');
  }
  const { files } = refused ? { files: [] } : await fetchProjectFiles(id, { limit: 100 }).catch(() => ({ files: [] }));
  const titles = new Map(files.map((f) => [f.id, f.title]));
  const focus = sp.link && UUID.test(sp.link) ? links.find((l) => l.id === sp.link) ?? null : null;
  const accesses: V2ShareLinkAccess[] = focus ? await listShareLinkAccessesV2(focus.id).catch(() => []) : [];
  const today = new Date().toISOString().slice(0, 10);
  const inTwoWeeks = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

  return (
    <PortalShell user={shell.user} builds={shell.builds} activeBuild={{ id, name }} section="documents" crumb="Share links">
      <main className="ste-page">
        <header className="ste-head">
          <h1>Share links</h1>
          <span className="ste-links"><Link href={`/projects/${id}/documents`}>Files</Link></span>
        </header>
        {refused ? <p role="alert" className="ste-error">{refused}</p> : (
          <>
            <ShareLinkCreate projectId={id} today={today} defaultExpiry={inTwoWeeks}
              files={files.map((f) => ({ id: f.id, name: `${f.title} · ${f.versionLabel}` }))} />
            <section aria-label="Links">
              <h2>Links</h2>
              {links.length === 0 ? <p className="ste-quiet">No links yet.</p> : (
                <ul className="crd-list">
                  {links.map((l) => (
                    <li key={l.id} className={`crd-item${focus?.id === l.id ? ' is-focus' : ''}`}>
                      <span className="crd-meta">
                        <strong>{l.audience}</strong><span>{statusWords(l)}</span><span>{usageWords(l)}</span>
                      </span>
                      <span className="crd-meta">{l.document_ids.map((d) => titles.get(d) ?? 'a removed file').join(' · ')}</span>
                      <span className="crd-act">
                        <Link className="btn" href={`/projects/${id}/documents/share?link=${l.id}`}>Access log</Link>
                        {l.status === 'active' ? <RevokeShareLink projectId={id} linkId={l.id} /> : null}
                      </span>
                      {focus?.id === l.id ? (
                        accesses.length === 0 ? <p className="ste-quiet">Nobody has opened it yet.</p> : (
                          <ul className="ste-log">{accesses.map((a) => <li key={a.id}>{accessWords(a, titles)}</li>)}</ul>
                        )
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </PortalShell>
  );
}
