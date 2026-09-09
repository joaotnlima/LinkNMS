// Surface 2 — Decision log. Chronological (newest first); a decision that was
// revised carries an "edited · rev N" badge that opens the full revision history
// with authors + timestamps — history is never lost. (design §7, FR2/FR7)
import { redirect } from 'next/navigation';

import { getBuild, getDecisions, isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { PencilEdit } from '@/components/icons';
import { formatDateTime, roleLabel } from '@/lib/format';
import type { Decision } from '@/lib/types';

function PartyTag({ role, name, verb }: { role: Decision['authorRole']; name: string; verb: string }) {
  return (
    <span className={`tag ${role}`}>
      <span className="pd" />
      {verb} · {name} ({roleLabel(role)})
    </span>
  );
}

function DecisionCard({ d }: { d: Decision }) {
  const edited = d.revisions.length > 1;
  return (
    <article className="lrow">
      <div className="spread">
        <span className="lt">{d.title}</span>
        {edited && (
          <span className="edited" title="This decision was revised">
            <PencilEdit />
            edited · rev {d.revisions.length}
          </span>
        )}
      </div>
      <p className="sub" style={{ color: 'var(--fg)' }}>{d.body}</p>
      <div className="meta">
        <PartyTag role={d.authorRole} name={d.authorName} verb="Logged" />
        <span className="cap data">{formatDateTime(d.createdAt)}</span>
      </div>
      {edited && (
        <details className="revs">
          <summary>Revision history ({d.revisions.length})</summary>
          {[...d.revisions].reverse().map((r) => (
            <div className="rev" key={r.rev}>
              <div className="spread">
                <span className="rt">Rev {r.rev}{r.rev === d.revisions.length ? ' (current)' : ''}</span>
                <span className="cap data">{formatDateTime(r.createdAt)}</span>
              </div>
              <div className="rb">{r.body}</div>
              <PartyTag role={r.authorRole} name={r.authorName} verb="By" />
            </div>
          ))}
        </details>
      )}
    </article>
  );
}

export default async function DecisionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/decisions`);

  const [build, decisions] = await Promise.all([getBuild(id), getDecisions(id)]);
  const shell = await buildShellContext(id, build.name);
  const sorted = [...decisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: build.name }}
      crumb="Decisions"
    >
      <main className="screen">
        <div>
          <h1 className="scr">Decision log</h1>
          <p className="sub">Everything agreed, in order. Corrections append a revision — the original is always kept.</p>
        </div>
        <div className="card">
          {sorted.length === 0 ? (
            <p className="notice">No decisions recorded yet.</p>
          ) : (
            sorted.map((d) => <DecisionCard key={d.id} d={d} />)
          )}
        </div>
      </main>
    </PortalShell>
  );
}
