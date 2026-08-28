// Surface 3c — The change-order detail that IS the one-screen answer (FR6):
// who decided, when, how much it moved the budget (before → after), plus the
// captured scope / schedule / quality notes (FR8). (design §7)
import { notFound } from 'next/navigation';
import { getChangeOrder, getProject, ApiError } from '@/lib/api';
import { CoStatusChip } from '@/components/CoStatusChip';
import { CoDecisionButtons } from '@/components/CoDecisionButtons';
import { StatusIcon } from '@/components/icons';
import { money, moneyPrecise, delta, formatDateTime, roleLabel } from '@/lib/format';

export default async function CoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let co;
  try {
    co = await getChangeOrder(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const project = await getProject('maple-street').catch(() => null);
  const d = delta(co.costDeltaCents);
  const decided = co.status !== 'proposed';
  // Owner may also decide (ADR-0004); the core rule is proposer ≠ decider.
  const canDecide = co.status === 'proposed' && project?.actingRole !== co.proposedByRole;

  return (
    <>
      <header className="topbar">
        <a className="back" href="/projects/maple-street/change-orders">‹ Change orders</a>
      </header>
      <main className="screen">
        <div className="spread">
          <h1 className="scr" style={{ maxWidth: '80%' }}>{co.title}</h1>
          <CoStatusChip status={co.status} />
        </div>

        {/* The answer, top of screen: who / when / how much. */}
        <section className="card" aria-label="Decision and budget impact">
          <div className="row">
            <span className="metric-lbl">Cost impact</span>
            <span className={`delta ${d.dir}`} style={{ fontSize: 22 }}>{d.text}</span>
          </div>
          <div className="row">
            <span className="metric-lbl">Budget {decided ? 'before → after' : 'if approved'}</span>
            <span className="cap data">
              {money(co.budgetBeforeCents)} → <strong>{money(co.budgetAfterCents)}</strong>
            </span>
          </div>
          <div className="row">
            <span className="metric-lbl">Raised by</span>
            <span className={`tag ${co.proposedByRole}`}>
              <span className="pd" />
              {co.proposedByName} ({roleLabel(co.proposedByRole)}) · {formatDateTime(co.createdAt)}
            </span>
          </div>
          <div className="row">
            <span className="metric-lbl">{co.status === 'rejected' ? 'Rejected by' : 'Decided by'}</span>
            {decided && co.decidedByName ? (
              <span className={`tag ${co.decidedByRole ?? 'owner'}`}>
                <span className="pd" />
                {co.decidedByName}
                {co.decidedByRole ? ` (${roleLabel(co.decidedByRole)})` : ''} ·{' '}
                {co.decidedAt ? formatDateTime(co.decidedAt) : ''}
              </span>
            ) : (
              <span className="badge warn">
                <StatusIcon name="alert-triangle" />
                Awaiting the other party
              </span>
            )}
          </div>
        </section>

        {/* Captured impact notes — never affect the budget total (FR8). */}
        <section className="card">
          <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <span className="grp">Scope impact</span>
            <span className="sub" style={{ color: 'var(--fg)' }}>{co.scopeImpactNote || 'None recorded.'}</span>
          </div>
          <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <span className="grp">Schedule impact</span>
            <span className="sub" style={{ color: 'var(--fg)' }}>
              {co.scheduleImpactDays != null ? `~${co.scheduleImpactDays} day${co.scheduleImpactDays === 1 ? '' : 's'}. ` : ''}
              {co.scheduleImpactNote || (co.scheduleImpactDays == null ? 'None recorded.' : '')}
            </span>
          </div>
          <div className="row">
            <span className="grp" style={{ margin: 0 }}>Quality flag</span>
            {co.qualityFlag ? (
              <span className="badge warn"><StatusIcon name="alert-triangle" />Flagged</span>
            ) : (
              <span className="badge ok"><StatusIcon name="check-circle" />None</span>
            )}
          </div>
          {co.qualityFlag && co.qualityNote && (
            <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <span className="grp">Quality note</span>
              <span className="sub" style={{ color: 'var(--fg)' }}>{co.qualityNote}</span>
            </div>
          )}
        </section>

        {co.status === 'proposed' && (
          <section aria-label="Decision">
            <CoDecisionButtons id={co.id} canDecide={!!canDecide} />
          </section>
        )}
      </main>
    </>
  );
}
