// The change-order detail — cut onto `/api/v2` (LINA-321, S4 of the UI cutover,
// doc 22 §3). This is the "one screen answer" (FR6): who proposed the change, its
// ledger-derived cost impact, its decision state, and — the slice's core — a
// decide control that HONOURS the two-sided rule (a proposer never sees an approve
// button on their own CO; doc 06 §6.1).
//
// ── WHAT V2 STATES, AND WHAT IT DOES NOT (LINA-358 ruling) ────────────────────
// The v2 CO is a contract-scoped, ledger record: `amount_delta` is SUMMED from
// BoQ line ops server-side, never free-typed. It carries no v1 "budget before →
// after" (that lives on the contract financials, GET /contracts/{id}/financials)
// and no party display name (the `Actor` is an org_id). So this renders the cost
// impact and the honest party labels (`resolveOrgLabel`) and does NOT invent a
// budget pair or a name — the free-cost narrative CO of v1 is retired.
//
// The v2 five-state lifecycle (draft/submitted/approved/rejected/withdrawn) is
// rendered by `CoStatusChipV2`, not the lossy three-state legacy chip.
//
// Fail-closed: a viewer with no active org, no mirror row, or who is not a party
// to the CO's contract gets `notFound()` — the read never leaks which change
// orders exist (doc 22 header, the S1 pattern).
import { notFound } from 'next/navigation';

import { getChangeOrderDetail } from '@/lib/v2/change-orders';
import { decideChangeOrderV2 } from './actions';
import { CoStatusChipV2 } from '@/components/CoStatusChipV2';
import { CoDecisionButtonsV2 } from '@/components/CoDecisionButtonsV2';
import { StatusIcon } from '@/components/icons';
import { delta, formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  scope: 'Scope',
  time: 'Time',
  scope_and_time: 'Scope & time',
};

export default async function CoDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const { id } = await params;
  const { project } = await searchParams;
  const detail = await getChangeOrderDetail(id);
  if (!detail) notFound();

  const { co, decide, canWithdraw, proposedByLabel, decidedByLabel } = detail;
  const d = delta(co.amountDeltaCents);
  const backHref =
    project && /^[\w-]+$/.test(project) ? `/projects/${project}/change-orders` : '/';

  return (
    <>
      <header className="topbar">
        <a className="back" href={backHref}>‹ Change orders</a>
      </header>
      <main className="screen">
        <div className="spread">
          <h1 className="scr" style={{ maxWidth: '80%' }}>
            {co.number ? `${co.number} · ` : ''}{co.title}
          </h1>
          <CoStatusChipV2 status={co.status} />
        </div>

        {/* The answer, top of screen: how much it moves the budget, and who. */}
        <section className="card" aria-label="Decision and budget impact">
          <div className="row">
            <span className="metric-lbl">Cost impact</span>
            <span className={`delta ${d.dir}`} style={{ fontSize: 22 }}>{d.text}</span>
          </div>
          <div className="row">
            <span className="metric-lbl">Kind</span>
            <span className="cap data">{KIND_LABEL[co.kind] ?? co.kind}</span>
          </div>
          <div className="row">
            <span className="metric-lbl">Running budget</span>
            <span className="cap">Tracked on the contract ledger</span>
          </div>
          <div className="row">
            <span className="metric-lbl">Proposed by</span>
            <span className="cap data">{proposedByLabel}</span>
          </div>
          <div className="row">
            <span className="metric-lbl">
              {co.status === 'rejected' ? 'Rejected by' : co.status === 'withdrawn' ? 'Withdrawn' : 'Decided by'}
            </span>
            {decidedByLabel ? (
              <span className="cap data">
                {decidedByLabel}
                {co.decidedAt ? ` · ${formatDateTime(co.decidedAt)}` : ''}
              </span>
            ) : (
              <span className="badge warn">
                <StatusIcon name="alert-triangle" />
                {co.status === 'submitted' ? 'Awaiting the other party' : 'Not yet decided'}
              </span>
            )}
          </div>
        </section>

        {/* What the change touches — the ledger ops behind the cost delta (FR8). */}
        <section className="card">
          <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <span className="grp">Reason</span>
            <span className="sub" style={{ color: 'var(--fg)' }}>{co.title || 'None recorded.'}</span>
          </div>
          <div className="row">
            <span className="grp" style={{ margin: 0 }}>Line changes</span>
            <span className="cap data">
              {co.lineCount} cost line{co.lineCount === 1 ? '' : 's'}
              {co.timeCount ? ` · ${co.timeCount} schedule change${co.timeCount === 1 ? '' : 's'}` : ''}
            </span>
          </div>
        </section>

        <section aria-label="Decision">
          <CoDecisionButtonsV2
            id={co.id}
            canDecide={decide.canDecide}
            cannotDecideMessage={decide.canDecide ? undefined : decide.message}
            canWithdraw={canWithdraw}
            onDecide={decideChangeOrderV2}
          />
        </section>
      </main>
    </>
  );
}
