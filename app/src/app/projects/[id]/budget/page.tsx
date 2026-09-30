// The Money surface — cut onto `/api/v2` (LINA-381, Phase 12b.2 of the v1
// deprecation, doc 22 §3.3). This is the standalone "Money" section of a build
// (PortalShell `section="money"`, reached from the pillar tile and the rail).
//
// ── WHAT CHANGED, AND WHY ─────────────────────────────────────────────────────
// It used to read the v1 budget projection (`getBudgetMovement` + `getPlan`) and
// render `MoneyMovement.tsx`, which split money into Slice-B3 `scope_change` vs
// `price_movement` rows. That model is RETIRED (LINA-362): on v2 money is the
// contracting/planning financial model, read as three registers — the summary
// (Σ contract financials), the moves (approved change orders), and the drift
// (open variations not yet formalised). See `lib/v2/money.ts` for the reads and
// `lib/v2/money-view.ts` for the aggregation. No v1 import reaches this surface.
//
// ── HONEST B2 EMPTY STATES ────────────────────────────────────────────────────
// A fresh v2 build is `draft`/`tendering` with no signed contract, so the only
// honest figure is the owner's `indicative_budget`; value/measured/paid are not
// asserted as zero-dollars-agreed but shown as "not yet". A signed-in viewer with
// no active org is a first-class "select an organisation" state, never a crash.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2 } from '@/lib/v2/record';
import { getMoneyV2 } from '@/lib/v2/money';
import {
  driftKindLabel,
  moveKindLabel,
  type MoneyViewV2,
  type V2VariationStatus,
} from '@/lib/v2/money-view';
import { moneyPrecise, delta, formatDate } from '@/lib/format';
import '@/components/record.css';

export const dynamic = 'force-dynamic';

export default async function MoneyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/budget`);

  const [record, money] = await Promise.all([getRecordV2(id), getMoneyV2(id)]);
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name }}
      section="money"
    >
      <main className="rc">
        <div className="rc-head">
          <div className="rc-head-l">
            <h1 className="rc-title">Money</h1>
            <p className="rc-lede">
              The budget as agreed, every approved move against it, and what is drifting but not yet
              formalised — the product&rsquo;s promise rendered as one surface.
            </p>
          </div>
        </div>

        {money == null ? (
          <section className="rc-panel">
            <p className="notice">
              There is nothing to show here yet for this build, or it is not visible to you.
            </p>
          </section>
        ) : money.noActiveOrg ? (
          <section className="rc-panel">
            <p className="notice">Select an organisation to see this build&rsquo;s money.</p>
          </section>
        ) : (
          <MoneySurface projectId={id} money={money} />
        )}
      </main>
    </PortalShell>
  );
}

function MoneySurface({ projectId, money }: { projectId: string; money: MoneyViewV2 }) {
  const { summary, moves, drift, indicativeBudgetCents } = money;
  const hasContract = summary.contractCount > 0;

  return (
    <>
      {/* ── Summary: what has been agreed and where it stands ──────────────── */}
      <section className="rc-budget card" aria-labelledby="rc-money-t">
        <h2 className="rc-sect-t" id="rc-money-t">Summary</h2>
        {hasContract ? (
          <>
            <div className="rc-budget-figs">
              <Fig label="Value" cents={summary.valueCents} />
              <Fig label="Approved changes" cents={summary.approvedChangesCents} signed />
              <Fig label="Measured" cents={summary.measuredCents} />
              <Fig label="Retention held" cents={summary.retentionHeldCents} />
              <Fig label="Paid" cents={summary.paidCents} />
              <Fig label="Outstanding" cents={summary.outstandingCents} />
            </div>
            <p className="cap">
              Folded across the {summary.contractCount === 1 ? 'contract' : `${summary.contractCount} contracts`}{' '}
              you can see. The value moves only through approved change orders (below); price and
              schedule drift are recorded but are <strong>not</strong> in these figures.
            </p>
          </>
        ) : indicativeBudgetCents != null ? (
          <>
            <div className="rc-budget-figs">
              <span className="rc-fig">
                <span className="grp">Indicative budget</span>
                <span className="num rc-fig-n">{moneyPrecise(indicativeBudgetCents)}</span>
              </span>
            </div>
            <p className="cap">
              No contract is signed yet, so this is the owner&rsquo;s target — not an agreed value.
              Measured and paid begin once a contract is signed.
            </p>
          </>
        ) : (
          <p className="notice">No priced scope yet — nothing is agreed until a contract is signed.</p>
        )}
      </section>

      {/* ── Moves: approved change orders — these moved the budget ──────────── */}
      <section className="rc-sect" aria-labelledby="rc-moves-t">
        <div className="rc-sect-hd">
          <h2 className="rc-sect-t" id="rc-moves-t">Approved changes</h2>
          <span className="badge warn">Moves the budget</span>
        </div>
        <p className="cap">
          Each approved change order is one move of the budget: who decided it, when, and how much it
          moved.
        </p>
        <div className="card">
          {moves.length === 0 ? (
            <p className="notice">
              No budget has moved — nothing has been approved against a contract yet.
            </p>
          ) : (
            moves.map((m) => {
              const d = delta(m.amountDeltaCents);
              return (
                <Link className="lrow" key={m.id} href={`/change-orders/${m.id}?project=${projectId}`}>
                  <div className="spread">
                    <span className="lt">
                      {m.number ? `${m.number} · ` : ''}
                      {m.title}
                    </span>
                    <span className={`amt delta ${d.dir}`}>{d.text}</span>
                  </div>
                  <div className="spread">
                    <span className="cap">
                      <span className="badge neutral">{moveKindLabel(m.kind)}</span>{' '}
                      {m.decidedByLabel}
                      {m.decidedAt ? ` · ${formatDate(m.decidedAt)}` : ''}
                    </span>
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </section>

      {/* ── Drift: variations not yet formalised — the early warning ────────── */}
      <section className="rc-sect" aria-labelledby="rc-drift-t">
        <div className="rc-sect-hd">
          <h2 className="rc-sect-t" id="rc-drift-t">Drifting</h2>
          <span className="badge neutral">Not yet a change order</span>
        </div>
        <p className="cap">
          Deviations from baseline that have <strong>not</strong> been formalised into a change
          order — the early warning, not a move of the budget.
        </p>
        <div className="card">
          {drift.length === 0 ? (
            <p className="notice">Nothing is drifting from baseline right now.</p>
          ) : (
            drift.map((v) => (
              <div className="lrow" key={v.id}>
                <div className="spread">
                  <span className="lt">{v.taskName}</span>
                  <DriftStatus status={v.status} />
                </div>
                <div className="spread">
                  <span className="cap">
                    <span className="badge neutral">{driftKindLabel(v.kind)}</span>
                    {v.cause ? ` · ${v.cause}` : ''}
                    {v.lastChangedAt ? ` · ${formatDate(v.lastChangedAt)}` : ''}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <p className="cap">
        Looking for the line each of these came from?{' '}
        <Link href={`/projects/${projectId}/record?tab=plan`}>Open the record</Link>.
      </p>
    </>
  );
}

function Fig({ label, cents, signed = false }: { label: string; cents: number; signed?: boolean }) {
  if (signed) {
    const d = delta(cents);
    return (
      <span className="rc-fig">
        <span className="grp">{label}</span>
        <span className={`num rc-fig-n delta ${d.dir}`}>{d.text}</span>
      </span>
    );
  }
  return (
    <span className="rc-fig">
      <span className="grp">{label}</span>
      <span className="num rc-fig-n">{moneyPrecise(cents)}</span>
    </span>
  );
}

function DriftStatus({ status }: { status: V2VariationStatus }) {
  // Colour is never the only signal (FR9): the status is a word.
  const cls = status === 'open' ? 'warn' : status === 'acknowledged' ? 'neutral' : 'ok';
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={`badge ${cls}`}>{label}</span>;
}
