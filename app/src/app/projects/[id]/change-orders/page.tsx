// Surface 3a — Change-order list. Status at a glance, chronological, with a clear
// entry point to raise one. Each row links to the "one screen" detail. (design §7)
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getBuild, getChangeOrders, isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { CoStatusChip } from '@/components/CoStatusChip';
import { formatDate, roleLabel, delta } from '@/lib/format';

export default async function ChangeOrdersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/change-orders`);

  const [build, cos] = await Promise.all([getBuild(id), getChangeOrders(id)]);
  const shell = await buildShellContext(id, build.name);
  const sorted = [...cos].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: build.name }}
      crumb="Change orders"
    >
      <main className="screen">
        <div className="spread">
          <div>
            <h1 className="scr">Change orders</h1>
            <p className="sub">Each carries a cost impact; nothing moves the budget until the other party approves.</p>
          </div>
        </div>
        <Link className="btn primary" href={`/projects/${id}/change-orders/new`}>
          + Raise change order
        </Link>
        <div className="card">
          {sorted.length === 0 ? (
            <p className="notice">No change orders yet.</p>
          ) : (
            sorted.map((co) => {
              const d = delta(co.costDeltaCents);
              return (
                <Link className="lrow" href={`/change-orders/${co.id}`} key={co.id}>
                  <div className="spread">
                    <span className="lt">{co.title}</span>
                    <CoStatusChip status={co.status} />
                  </div>
                  <div className="spread">
                    <span className="cap">
                      {co.proposedByName} ({roleLabel(co.proposedByRole)}) · {formatDate(co.createdAt)}
                    </span>
                    <span className={`amt delta ${d.dir}`}>{d.text}</span>
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </main>
    </PortalShell>
  );
}
