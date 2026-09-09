// D16 — Budget: materials & price movement (LINA-218).
//
// Pen: "Desktop — Bootstrap flow (lg)" › D16. Contract:
// docs/architecture/slice-b3-live-record-materials-contract.md §3c + §5.
// Decision: ADR-0014 §2/§3.
//
// ── WHY TWO SECTIONS AND NOT ONE TABLE WITH A `kind` COLUMN ──────────────────
// A single table sorted by date, with a column saying which kind each row is, is
// the obvious layout and it is the wrong one. It invites the eye to run down the
// value column and add it up, and the sum of that column is a number that means
// nothing: a price movement did not move the contract total. The whole point of
// ADR-0014 §3 — enforced in the database by a CHECK, and structurally separated
// on the wire into two arrays — evaporates the moment the screen re-merges them.
// So they are two sections with two subtotals and no combined figure anywhere.
//
// ── WHY A PRICE MOVEMENT IS SHOWN AGAINST THE BASELINE UNIT PRICE ────────────
// "$4.20 → $4.60 per unit" reads as a price that moved. The same fact rendered
// as "+$1,200" reads as someone deciding to spend more, which is a scope change,
// which is a different conversation with a different party at fault. The unit
// prices are the sentence; the value delta is the footnote (§5).
//
// This is a server component: it renders a projection and owns no interaction.
import Link from 'next/link';

import { moneyPrecise, delta, formatDateTime } from '@/lib/format';
import { moneyTotals, priceCauseLabel, type MoneyView } from '@/lib/record';

export interface MoneyMovementProps {
  projectId: string;
  view: MoneyView;
  /** partyId → display name, from the build's member directory. */
  nameOf: (partyId: string | null | undefined) => string;
  /** stageId → line name, so a movement names the line it moved, not a uuid. */
  lineNameOf: (stageId: string) => string | null;
  /** `h2` inside the D14 tab panel; `h1` on the standalone budget surface. */
  headingLevel?: 'h1' | 'h2';
}

export function MoneyMovement({
  projectId, view, nameOf, lineNameOf, headingLevel = 'h2',
}: MoneyMovementProps) {
  const H = headingLevel;
  const totals = moneyTotals(view);
  const contractDelta = delta(view.currentBudgetCents - view.baselineBudgetCents);

  return (
    <div className="rc-money">
      {/* The contract total, and the sentence that says what did and did not
          reach it. Stated at the top because it is the figure every row below is
          measured against — and because saying "price movements are NOT in this"
          once, loudly, is worth more than a caveat repeated per row. */}
      <section className="rc-budget card" aria-labelledby="rc-budget-t">
        <H className="rc-budget-t" id="rc-budget-t">Contract total</H>
        <div className="rc-budget-figs">
          <span className="rc-fig">
            <span className="grp">Baseline</span>
            <span className="num rc-fig-n">{moneyPrecise(view.baselineBudgetCents)}</span>
          </span>
          <span className="rc-fig">
            <span className="grp">Current</span>
            <span className="num rc-fig-n">{moneyPrecise(view.currentBudgetCents)}</span>
          </span>
          <span className="rc-fig">
            <span className="grp">Moved</span>
            <span className={`num rc-fig-n delta ${contractDelta.dir}`}>{contractDelta.text}</span>
          </span>
        </div>
        <p className="cap">
          The contract total moves through approved change orders and nothing else. Price
          movements are recorded below and are <strong>not</strong> in this figure.
        </p>
      </section>

      {/* ── Section 1: scope changes — these moved the contract ─────────────── */}
      <section className="rc-sect" aria-labelledby="rc-scope-t">
        <div className="rc-sect-hd">
          <h3 className="rc-sect-t" id="rc-scope-t">Scope changes</h3>
          <span className="badge warn">Moves the contract total</span>
        </div>
        <p className="cap">
          Someone changed what is being built. Each one opened a change order, and the money
          lands only when that change order is approved by both parties.
        </p>

        {view.scopeChanges.length === 0 ? (
          <p className="notice">No scope changes recorded against the baseline.</p>
        ) : (
          <ul className="rc-rows card">
            {view.scopeChanges.map((row) => {
              const d = delta(row.valueDeltaCents);
              const line = lineNameOf(row.stageId);
              return (
                <li key={row.movementId} className="rc-row">
                  <span className="rc-row-main">
                    <span className="rc-row-t">{line ?? 'A line on the plan'}</span>
                    <span className="cap">
                      {nameOf(row.movedByPartyId)} · {formatDateTime(row.occurredAt)}
                    </span>
                    {/* Sourced: for a scope change the source IS the change
                        order — that is where the reasoning and the two stamps
                        live, so the row links there rather than restating it. */}
                    {row.changeOrder.id ? (
                      <Link className="rc-row-src" href={`/change-orders/${row.changeOrder.id}`}>
                        See the change order →
                      </Link>
                    ) : (
                      <span className="cap">Change order reference missing on this row.</span>
                    )}
                  </span>
                  <span className={`num rc-row-amt delta ${d.dir}`}>{d.text}</span>
                </li>
              );
            })}
            <li className="rc-subtotal">
              <span className="grp">Scope change subtotal</span>
              <span className={`num delta ${delta(totals.scopeChangeCents).dir}`}>
                {delta(totals.scopeChangeCents).text}
              </span>
            </li>
          </ul>
        )}
      </section>

      {/* ── Section 2: price movements — these did NOT move the contract ────── */}
      <section className="rc-sect" aria-labelledby="rc-price-t">
        <div className="rc-sect-hd">
          <h3 className="rc-sect-t" id="rc-price-t">Price movements</h3>
          <span className="badge neutral">Does not move the contract total</span>
        </div>
        <p className="cap">
          What is being built did not change — what it costs to buy did. Recorded, dated and
          attributed so the pressure on the budget is visible before it becomes an argument.
        </p>

        {view.priceMovements.length === 0 ? (
          <p className="notice">No price movements recorded against the baseline.</p>
        ) : (
          <ul className="rc-rows card">
            {view.priceMovements.map((row) => {
              const d = delta(row.valueDeltaCents);
              const line = lineNameOf(row.stageId);
              return (
                <li key={row.movementId} className="rc-row">
                  <span className="rc-row-main">
                    <span className="rc-row-t">{line ?? 'A line on the plan'}</span>
                    {/* The price sentence, against the BASELINE price (§5). A
                        null baseline means the material row could not be read;
                        saying so beats drawing an arrow from nowhere. */}
                    <span className="rc-row-price num">
                      {row.baselineUnitPriceCents == null ? (
                        <>unit price now {moneyPrecise(row.newUnitPriceCents)}</>
                      ) : (
                        <>
                          {moneyPrecise(row.baselineUnitPriceCents)} → {moneyPrecise(row.newUnitPriceCents)}{' '}
                          <span className="cap">per unit, against the baseline price</span>
                        </>
                      )}
                    </span>
                    <span className="cap">
                      {priceCauseLabel(row.priceCause)}
                      {row.source ? ` · ${row.source}` : ' · no source given'}
                    </span>
                    <span className="cap">
                      {nameOf(row.movedByPartyId)} · {formatDateTime(row.occurredAt)}
                    </span>
                  </span>
                  <span className={`num rc-row-amt delta ${d.dir}`}>{d.text}</span>
                </li>
              );
            })}
            <li className="rc-subtotal">
              <span className="grp">Price movement subtotal</span>
              <span className={`num delta ${delta(totals.priceMovementCents).dir}`}>
                {delta(totals.priceMovementCents).text}
              </span>
            </li>
          </ul>
        )}
      </section>

      <p className="cap">
        Every row here is one event on the shared record.{' '}
        <Link href={`/projects/${projectId}/audit`}>Check it in the audit trail</Link>.
      </p>
    </div>
  );
}
