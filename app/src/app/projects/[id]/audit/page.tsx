// Surface 4 — Audit view, the History rail section — cut onto `/api/v2`
// (LINA-382, Phase 12b.3). The full ledger in `seq` order with the chain-verify
// result made tangible: a visible "integrity: verified" banner, or the exact
// first broken seq if the chain ever fails.
//
// ── ONE v2 LEDGER, TWO SURFACES ───────────────────────────────────────────────
// This reads the SAME v2 audit ledger as the record page's History tab
// (`listRecord`, LINA-359) via `getAuditV2`, but is the fuller tamper-evidence
// view: it pages the WHOLE chain (not just the first page), prints each entry's
// hash, and calls `record:verify` for the integrity verdict — v2's split-out
// equivalent of the v1 `getAudit` response's inline `verified`/`headHash`.
//
// ── FIELD PARITY WITH v1, HONESTLY ────────────────────────────────────────────
// v2's V7-redacted `AuditEntry` carries an ORG-level actor (org_role), not a
// person name, and the ledger carries no budget-delta — that Slice-B3 movement
// model was never ported to v2 (record-view.ts). So the row shows the event
// sentence, the acting org role, the timestamp and the entry hash, and drops the
// per-row budget delta the v1 page inferred rather than inventing one. Redaction
// is preserved: an out-of-scope entry shows only that a change happened, keeping
// the chain complete and verifiable without leaking withheld content.
import { redirect } from 'next/navigation';

import { isSignedIn } from '@/lib/api';
import { getAuditV2, type AuditV2 } from '@/lib/v2/record';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { PortalShell } from '@/components/PortalShell';
import { ShieldCheck, StatusIcon } from '@/components/icons';
import { formatDateTime } from '@/lib/format';
import type { RecordHistoryLineV2 } from '@/lib/v2/record-view';
import '@/components/record.css';

export const dynamic = 'force-dynamic';

function EventRow({ ev }: { ev: RecordHistoryLineV2 }) {
  return (
    <div className={`ev${ev.redacted ? ' is-redacted' : ''}`}>
      <span className="seq">#{ev.seq}</span>
      <div>
        <div className="ev-t">{ev.sentence}</div>
        <div className="cap">
          {ev.redacted
            ? 'Content withheld — outside your access'
            : `${ev.actorOrgRole ? `by a ${ev.actorOrgRole} · ` : ''}${formatDateTime(ev.occurredAt)}`}
        </div>
        <div className="ev-h" title="Entry hash — links this event to the previous one">
          hash {ev.entryHash}
        </div>
      </div>
      <span className="cap">{ev.category}</span>
    </div>
  );
}

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/audit`);

  const audit = await getAuditV2(id);
  // Fail-closed (S1): a viewer who cannot see this build (not mirrored, no active
  // org, not a participant) gets a resolved-but-empty surface, never a crash and
  // never another party's data.
  const name = 'This build';
  const shell = await buildShellContextV2(id, name);
  const activeName = shell.builds.find((b) => b.id === id)?.name ?? name;

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: activeName }}
      section="history"
    >
      <main className="screen">
        <div>
          <h1 className="scr">Audit trail</h1>
          <p className="sub">Every decision and change, in the order it happened — tamper-evident by a hash chain.</p>
        </div>

        {audit ? <AuditBody audit={audit} /> : <EmptyAudit />}
      </main>
    </PortalShell>
  );
}

function AuditBody({ audit }: { audit: AuditV2 }) {
  if (audit.length === 0) return <EmptyAudit />;

  // Ascending by seq: the audit trail reads oldest → newest so the chain is
  // followed in the order it was written (the record History tab shows the same
  // events newest-first — a different question, the same ledger).
  const ordered = [...audit.events].sort((a, b) => a.seq - b.seq);

  return (
    <>
      {audit.verified ? (
        <div className="integrity ok" role="status">
          <ShieldCheck />
          Integrity: verified — all {audit.length} entries chain cleanly.
          {audit.headHash ? ` Head ${audit.headHash}.` : ''}
        </div>
      ) : (
        <div className="integrity bad" role="alert">
          <StatusIcon name="alert-octagon" />
          Integrity check FAILED — chain breaks at entry #{audit.firstInvalidSeq}. Escalated for investigation.
        </div>
      )}

      {audit.truncated ? (
        <p className="sub">
          Showing the most recent {audit.events.length} of {audit.length} entries. The integrity check above
          still covers the whole chain.
        </p>
      ) : null}

      <div className="card ledger" aria-label="Ledger entries in order">
        {ordered.map((ev) => (
          <EventRow key={ev.seq} ev={ev} />
        ))}
      </div>
    </>
  );
}

function EmptyAudit() {
  return (
    <div className="integrity ok" role="status">
      <ShieldCheck />
      Nothing has been recorded against this build yet — the chain is empty.
    </div>
  );
}
