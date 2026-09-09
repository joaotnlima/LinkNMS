// Surface 1 — Project dashboard. Status before detail: the four-pillar panel a
// stressed owner reads in one glance, then current budget vs baseline, then the
// entry points into the record. (design §7, FR8/FR9)
import Link from 'next/link';
import { getProject } from '@/lib/api';
import { PillarPanel } from '@/components/PillarPanel';
import { TopBar, BottomNav } from '@/components/chrome';
import { Check } from '@/components/icons';
import { money, moneyPrecise, delta } from '@/lib/format';

export default async function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await getProject(id);
  const d = delta(p.currentBudgetCents - p.baselineBudgetCents);
  const overBaseline = p.currentBudgetCents > p.baselineBudgetCents;
  // Bar width: current relative to baseline, clamped so a small overage still reads.
  const pct = Math.min(100, Math.round((p.currentBudgetCents / p.baselineBudgetCents) * 100));
  const co = p.counts.changeOrders;

  return (
    <>
      <TopBar />
      <main className="screen">
        <div>
          <div className="crumbs">Shared record</div>
          <h1 className="scr">{p.name}</h1>
          <p className="sub">
            {p.members.map((m) => `${m.name} (${m.role === 'owner' ? 'Owner' : 'GC'})`).join(' · ')}
          </p>
        </div>

        {/* FR1 is not finished until the second party is actually on the record —
            a "shared" record with one member shares nothing. Surfaced here as a
            live prompt rather than buried in a settings screen, and only for the
            owner, who is the only party allowed to invite. */}
        {p.actingRole === 'owner' && !p.members.some((m) => m.role === 'counterparty') ? (
          <Link className="card row" href={`/projects/${id}/invite`}>
            <span style={{ fontWeight: 600 }}>👷 Invite your general contractor</span>
            <span className="cap">no GC on this record yet →</span>
          </Link>
        ) : null}

        <section aria-labelledby="status-h" className="stack">
          <h2 id="status-h" className="grp">Project status</h2>
          <PillarPanel pillars={p.pillars} />
        </section>

        <section aria-labelledby="budget-h" className="card">
          <div className="row">
            <div>
              <div className="metric-lbl">Current budget</div>
              <div className="amt" style={{ fontSize: 22 }}>{moneyPrecise(p.currentBudgetCents)}</div>
            </div>
            <span className={`badge ${overBaseline ? 'warn' : 'ok'}`}>
              <Check className="ok-stroke" />
              {overBaseline ? `${d.text} vs baseline` : 'On budget'}
            </span>
          </div>
          <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <div className="spread">
              <span className="cap">Baseline {money(p.baselineBudgetCents)}</span>
              <span className={`cap delta ${d.dir}`}>{d.text}</span>
            </div>
            <div className={`budgetbar ${overBaseline ? 'over' : ''}`}>
              <span style={{ width: `${pct}%` }} />
            </div>
            <span className="cap">
              {co.approved} approved change{co.approved === 1 ? '' : 's'} applied ·{' '}
              {co.proposed} pending review
            </span>
          </div>
        </section>

        <section className="card">
          {/* The way in to D14 (LINA-218), listed FIRST. The record is the thing
              this product is: the plan, the schedule, the money and the history
              of all three in one place. Everything below it is a slice of the
              same record reached directly. */}
          <Link className="row" href={`/projects/${id}/record`}>
            <span style={{ fontWeight: 600 }}>📖 The record</span>
            <span className="cap">plan · schedule · money · history →</span>
          </Link>
          <Link className="row" href={`/projects/${id}/budget`}>
            <span style={{ fontWeight: 600 }}>💷 Budget movement</span>
            <span className="cap">scope changes and price movements →</span>
          </Link>
          {/* The way in to D7 (LINA-207). The dashboard is where both parties
              land, and until this row existed the plan surface was reachable
              only by typing the URL. It is listed for BOTH roles — the owner
              reads the plan, the GC brings it in — and the plan page itself is
              what states which of those the reader is. */}
          <Link className="row" href={`/projects/${id}/plan`}>
            <span style={{ fontWeight: 600 }}>🗓️ Plan</span>
            <span className="cap">actions, sub-actions and dates →</span>
          </Link>
          <Link className="row" href={`/projects/${id}/decisions`}>
            <span style={{ fontWeight: 600 }}>📋 Decision log</span>
            <span className="cap">{p.counts.decisions} decisions →</span>
          </Link>
          <Link className="row" href={`/projects/${id}/change-orders`}>
            <span style={{ fontWeight: 600 }}>🔁 Change orders</span>
            <span className="cap">{co.total} total · {co.proposed} pending →</span>
          </Link>
          <Link className="row" href={`/projects/${id}/audit`}>
            <span style={{ fontWeight: 600 }}>🛡️ Audit trail</span>
            <span className="cap">integrity: verified →</span>
          </Link>
        </section>
      </main>
      <BottomNav projectId={id} active="home" />
    </>
  );
}
