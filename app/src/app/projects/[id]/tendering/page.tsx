// /projects/{id}/tendering — the tendering home (PRD-08 H-1, to-be/20 §3).
//
// Every RFP the viewer can see on the project, grouped by lifecycle state, each
// with what it covers, when bids are due, `n/m in` and open questions (issuer),
// or the viewer's own bid (bidder). ONE read (listProjectRfps): the module
// decides which RFPs and which facts each viewer may see — the counts are
// absent for a bidder (V8), so this page cannot show what it was not given.
import Link from 'next/link';

import { PortalShell } from '@/components/PortalShell';
import { listProjectRfps } from '@/lib/v2/tendering-home';
import {
  bidsDueLabel, coversText, groupByLifecycle, inLabel, myLaneLabel, newRfpPath, openQuestionsLabel, rfpPath,
} from '@/lib/v2/tendering-home-view';
import { rfpStatusBadge } from '@/lib/v2/tendering-view';
import { loadTenderingFrame, requireSignedIn } from './load';
import '@/components/tender/tender.css';
import '@/components/plan-import.css';

export const dynamic = 'force-dynamic';

export default async function TenderingHomePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireSignedIn(`/projects/${id}/tendering`);
  const [frame, items] = await Promise.all([loadTenderingFrame(id), listProjectRfps(id)]);
  const nowIso = new Date().toISOString();
  const groups = groupByLifecycle(items ?? []);

  return (
    <PortalShell user={frame.shell.user} builds={frame.shell.builds} activeBuild={{ id, name: frame.name }}
      crumb="Tendering" align="start">
      <main className="pi">
        <div className="tnd tnd-home">
          <div className="tnd-row is-split">
            <h2 className="tnd-h" style={{ fontSize: 18 }}>Tendering</h2>
            <div className="tnd-row">
              <Link className="btn sm" href={`/projects/${id}/plan`}>Back to plan</Link>
              {frame.canIssue && frame.isParticipant ? (
                <Link className="btn primary sm" href={newRfpPath(id)}>New RFP</Link>
              ) : null}
            </div>
          </div>

          {!frame.hasActiveOrg ? (
            <p className="tnd-note is-strong">
              Select an organisation to see its tenders. RFPs belong to the organisation that issues or bids on them.
            </p>
          ) : items === null ? (
            <p className="tnd-note is-strong">There is nothing here you can open.</p>
          ) : groups.length === 0 ? (
            <p className="tnd-note is-strong">
              No tenders yet. Open a task in the plan and request proposals from its Tender tab, or start one here.
            </p>
          ) : groups.map((g) => (
            <section key={g.label} className="tnd-home-grp" aria-label={g.label}>
              <b className="tnd-h">{g.label} <span className="tnd-note">({g.items.length})</span></b>
              {g.items.map((r) => {
                const badge = rfpStatusBadge(r.status);
                const n = inLabel(r);
                const q = openQuestionsLabel(r);
                const lane = myLaneLabel(r);
                return (
                  <Link key={r.id} className="tnd-home-item" href={rfpPath(id, r.id)}>
                    <span className="t">{r.title}</span>
                    <span className="side">
                      <span className={`tnd-badge ${badge.tone === 'quiet' ? '' : badge.tone}`}>{badge.label}</span>
                    </span>
                    <span className="meta">
                      {[coversText(r), r.purpose === 'design' ? 'design' : 'build', bidsDueLabel(r, nowIso)].join(' · ')}
                      {r.status === 'cancelled' && r.cancel_reason ? ` · Cancelled: ${r.cancel_reason}` : ''}
                      {r.awarded_to?.name ? ` · Awarded to ${r.awarded_to.name}` : ''}
                    </span>
                    <span className="side">
                      {n ? <b className="tnd-num">{n}</b> : null}
                      {q ? <span className="tnd-tab-q" title={q} aria-label={q}>{r.open_question_count}</span> : null}
                      {lane ? <span className="meta">{lane}</span> : null}
                    </span>
                  </Link>
                );
              })}
            </section>
          ))}
        </div>
      </main>
    </PortalShell>
  );
}
