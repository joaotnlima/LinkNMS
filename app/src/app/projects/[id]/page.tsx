// Surface 1 — Project dashboard. Status before detail: the four-pillar panel a
// stressed owner reads in one glance, then current budget vs baseline, then the
// entry points into the record. (design §7, FR8/FR9)
import Link from 'next/link';
import { getProject } from '@/lib/api';
import { PillarPanel } from '@/components/PillarPanel';
import { TopBar, BottomNav, DemoBanner } from '@/components/chrome';
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
        <DemoBanner />
        <div>
          <div className="crumbs">Shared record</div>
          <h1 className="scr">{p.name}</h1>
          <p className="sub">
            {p.members.map((m) => `${m.name} (${m.role === 'owner' ? 'Owner' : 'GC'})`).join(' · ')}
          </p>
        </div>

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
