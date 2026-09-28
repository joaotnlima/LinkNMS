// Change-order list — cut onto `/api/v2` (LINA-321, S4 of the UI cutover, doc 22
// §3). The project roll-up, chronological-ish (id-ordered page from the v2
// collection read, LINA-357), each row a link to the "one screen" detail. Reads
// `listChangeOrders` on `/api/v2`; every build that reaches this page is a v2
// build (S1 lists only v2 builds), so there is no v1 fallback.
//
// ── FIRST-CLASS EMPTY / WITHHELD STATES (doc 22 header, S1 pattern) ───────────
// The v2 access model is org-centric. A signed-in viewer with NO active org is not
// an error — the list says "select an organisation" rather than implying the
// project has no change orders. A row the viewer may see only by EXISTENCE (a
// party of a back-to-back linked contract, ancestor ruling 11) renders as a locked
// row with its commercial body withheld, never a crash on a missing `proposed_by`.
//
// ── RAISING A CHANGE ORDER IS DEFERRED (LINA-358 ruling 2) ────────────────────
// The v1 free-cost `RaiseChangeOrderForm` is retired: v2 money is derived from BoQ
// line ops against a SIGNED contract, so proposing needs the contract + BoQ
// authoring surface that arrives with S2. Until then this page reads/decides but
// does not link the retired form — the entry point is shown as pending, honestly.
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2 } from '@/lib/v2/record';
import { listChangeOrders } from '@/lib/v2/change-orders';
import { CoStatusChipV2 } from '@/components/CoStatusChipV2';
import { StatusIcon } from '@/components/icons';
import { delta } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ChangeOrdersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/change-orders`);

  const [record, list] = await Promise.all([getRecordV2(id), listChangeOrders(id)]);
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name }}
      crumb="Change orders"
    >
      <main className="screen">
        <div className="spread">
          <div>
            <h1 className="scr">Change orders</h1>
            <p className="sub">Each carries a cost impact; nothing moves the budget until the other party approves.</p>
          </div>
        </div>

        {/* Propose arrives with the contract + BoQ surface (S2); the free-cost form
            is retired (LINA-358). Shown as pending rather than linking a dead route. */}
        <button className="btn primary" disabled title="Raising a change order arrives with the contract surface">
          + Raise change order
        </button>

        <div className="card">
          {list.noActiveOrg ? (
            <p className="notice">Select an organisation to see this project&rsquo;s change orders.</p>
          ) : list.rows.length === 0 ? (
            <p className="notice">No change orders yet.</p>
          ) : (
            list.rows.map((row) =>
              row.existenceOnly ? (
                <div className="lrow" key={row.id} aria-label="Linked change order (details withheld)">
                  <div className="spread">
                    <span className="lt" style={{ color: 'var(--muted)' }}>
                      <StatusIcon name="shield" /> Linked change order
                    </span>
                    <CoStatusChipV2 status={row.status} />
                  </div>
                  <div className="spread">
                    <span className="cap">{row.withheldReason ?? 'Commercial details visible to its parties.'}</span>
                  </div>
                </div>
              ) : (
                <Link className="lrow" href={`/change-orders/${row.id}?project=${id}`} key={row.id}>
                  <div className="spread">
                    <span className="lt">
                      {row.number ? `${row.number} · ` : ''}{row.title}
                    </span>
                    <CoStatusChipV2 status={row.status} />
                  </div>
                  <div className="spread">
                    <span className="cap">{row.proposedByOrgId ? 'Contract party' : ''}</span>
                    <span className={`amt delta ${delta(row.amountDeltaCents ?? 0).dir}`}>
                      {delta(row.amountDeltaCents ?? 0).text}
                    </span>
                  </div>
                </Link>
              ),
            )
          )}
        </div>
      </main>
    </PortalShell>
  );
}
