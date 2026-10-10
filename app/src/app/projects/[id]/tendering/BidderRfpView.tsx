// The RFP detail as a BIDDER org reads it in-app (PRD-08 H-2 + H-6): the scope
// it is asked to price, the dates, the published answers and its own questions,
// and the ask box. Everything comes from getRfp, which the module already
// projects for a bidder (package without prices; answered questions + its own;
// the asker never named) — this renders, it never filters.
import Link from 'next/link';

import { askClarificationAction } from '@/components/procurement-actions';
import { BidderClarifications } from '@/components/tender/Clarifications';
import { fmtDeadline } from '@/lib/v2/tender-flow-view';
import { tenderingPath } from '@/lib/v2/tendering-home-view';
import { rfpStatusBadge, type V2Rfp } from '@/lib/v2/tendering-view';

export function BidderRfpView({ projectId, rfp, myProposalStatus }: {
  projectId: string;
  rfp: V2Rfp;
  myProposalStatus: string | null;
}) {
  const badge = rfpStatusBadge(rfp.status);
  const rows = rfp.package?.rows ?? [];
  const items = rfp.package?.items ?? [];
  return (
    <div className="tnd">
      <header className="tnd-ws-hd">
        <Link className="btn sm" href={tenderingPath(projectId)}>← All tenders</Link>
        <h3>{rfp.title}</h3>
        <span className={`tnd-badge ${badge.tone === 'quiet' ? '' : badge.tone}`}>{badge.label}</span>
      </header>
      <dl className="tnd-kv">
        <dt>Bids due</dt>
        <dd><b>{fmtDeadline(rfp.submission_deadline)}</b></dd>
        <dt>Questions</dt>
        <dd>{rfp.questions_deadline ? `until ${fmtDeadline(rfp.questions_deadline)}` : 'until bids are due'}</dd>
        <dt>Your bid</dt>
        <dd>{myProposalStatus === 'submitted' || myProposalStatus === 'shortlisted' ? 'In' : myProposalStatus ?? 'Not started'}</dd>
      </dl>
      {rfp.scope_text ? <p className="tnd-note is-strong" style={{ whiteSpace: 'pre-wrap' }}>{rfp.scope_text}</p> : null}
      <section className="tnd" style={{ gap: 8 }} aria-label="Scope">
        <b className="tnd-h">Scope</b>
        {rows.length === 0 ? <p className="tnd-note">No rows in the package.</p> : (
          <div className="tnd-card">
            {rows.map((r) => <div key={r.task_id} className="tnd-inv"><span className="e">{r.name}</span></div>)}
          </div>
        )}
        {items.length > 0 ? <p className="tnd-note">{items.length} priced lines asked for — prices are yours to give.</p> : null}
      </section>
      {rfp.status === 'published' ? (
        rfp.visibility === 'open' ? (
          <div className="tnd-row">
            <Link className="btn primary sm" href={`/marketplace/bid/${rfp.id}`}>Price and send your bid →</Link>
          </div>
        ) : (
          <p className="tnd-note">Send your bid from the personal link in your invitation email.</p>
        )
      ) : null}
      <BidderClarifications
        items={rfp.clarifications ?? []}
        questionsOpen={rfp.questions_open ?? false}
        questionsDeadline={rfp.questions_deadline ?? null}
        rfpStatus={rfp.status}
        ask={askClarificationAction.bind(null, rfp.id)}
      />
    </div>
  );
}
