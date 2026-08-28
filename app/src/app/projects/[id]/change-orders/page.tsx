// Surface 3a — Change-order list. Status at a glance, chronological, with a clear
// entry point to raise one. Each row links to the "one screen" detail. (design §7)
import Link from 'next/link';
import { getChangeOrders } from '@/lib/api';
import { TopBar, BottomNav } from '@/components/chrome';
import { CoStatusChip } from '@/components/CoStatusChip';
import { formatDate, roleLabel, delta } from '@/lib/format';

export default async function ChangeOrdersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cos = await getChangeOrders(id);
  const sorted = [...cos].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <>
      <TopBar back={{ href: `/projects/${id}`, label: 'Home' }} />
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
      <BottomNav projectId={id} active="change-orders" />
    </>
  );
}
