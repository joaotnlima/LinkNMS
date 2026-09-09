// Surface 4 — Audit view. The full ledger in `seq` order with the chain-verify
// result made tangible: a visible "integrity: verified" banner, or the exact
// first broken seq if the chain ever fails. Covers decisions, change orders and
// (later) plan/progress events. Budget deltas are shown inline so the running
// budget trail is legible. (design §7, FR2/FR7, Acceptance)
import { redirect } from 'next/navigation';

import { getAudit, getBuild, isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { ShieldCheck, StatusIcon } from '@/components/icons';
import { formatDateTime, delta, roleLabel } from '@/lib/format';
import type { AuditEvent } from '@/lib/types';

function EventRow({ ev }: { ev: AuditEvent }) {
  const moved = ev.budgetDeltaCents != null && ev.budgetDeltaCents !== 0;
  const d = moved ? delta(ev.budgetDeltaCents!) : null;
  return (
    <div className="ev">
      <span className="seq">#{ev.seq}</span>
      <div>
        <div className="ev-t">{ev.summary}</div>
        <div className="cap">
          {ev.actorName} ({roleLabel(ev.actorRole)}) · {formatDateTime(ev.createdAt)}
        </div>
        <div className="ev-h" title="Entry hash — links this event to the previous one">
          hash {ev.entryHash}
        </div>
      </div>
      {d ? <span className={`amt delta ${d.dir}`}>{d.text}</span> : <span className="cap">—</span>}
    </div>
  );
}

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/audit`);

  const [build, audit] = await Promise.all([getBuild(id), getAudit(id)]);
  const shell = await buildShellContext(id, build.name);
  const verified = audit.verified === true;
  const ordered = [...audit.events].sort((a, b) => a.seq - b.seq);

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: build.name }}
      section="history"
    >
      <main className="screen">
        <div>
          <h1 className="scr">Audit trail</h1>
          <p className="sub">Every decision and change, in the order it happened — tamper-evident by a hash chain.</p>
        </div>

        {verified ? (
          <div className="integrity ok" role="status">
            <ShieldCheck />
            Integrity: verified — all {audit.events.length} entries chain cleanly. Head {audit.headHash}.
          </div>
        ) : (
          <div className="integrity bad" role="alert">
            <StatusIcon name="alert-octagon" />
            Integrity check FAILED — chain breaks at entry #{audit.verified}. Escalated for investigation.
          </div>
        )}

        <div className="card ledger" aria-label="Ledger entries in order">
          {ordered.map((ev) => (
            <EventRow key={ev.seq} ev={ev} />
          ))}
        </div>
      </main>
    </PortalShell>
  );
}
