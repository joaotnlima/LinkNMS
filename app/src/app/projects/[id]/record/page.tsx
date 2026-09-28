// D14 — The record, live (LINA-218) — cut onto `/api/v2` (LINA-353, S2 of the UI
// cutover, doc 22 §3).
//
// Pen: "Desktop — Bootstrap flow (lg)" › D14. v1 contract:
// docs/architecture/slice-b3-live-record-materials-contract.md §3a + §5.
//
// ── FOUR TABS, FOUR URLS ──────────────────────────────────────────────────────
// The tabs are LINKS carrying `?tab=`, not client state — this screen is the
// product's answer to "who decided this, when, and how much did it move the
// budget", an answer you paste into an email, and `?tab=money` survives that
// where `useState` does not. That is unchanged from v1.
//
// ── WHAT S2 CUTS OVER, AND WHAT IT HONESTLY LEAVES FOR THE v2 RECORD SLICE ─────
// The v1 page read ONE `getRecord` projection for all four tabs. On v2 only two
// of the four have a backing read (verified against the live backend, doc 22 §3):
//
//   • Header / state + Schedule tab ← `getRecordV2` (getProject + getSchedule).
//   • Plan (materials) + Money (movements) + History (audit ledger) ← nothing.
//     The Slice-B3 materials/movements model was never ported to a v2 module, and
//     `listRecord` (the ledger projection) is registered nowhere. Under B2 (fresh
//     start) a fresh v2 project has no materials, no movements and an empty
//     ledger, so those three tabs render an honest "arrives with the v2 record
//     slice" panel rather than fake data. When that backend lands they light up
//     with no change to this page's shape — see `lib/v2/record-view.ts`.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2, getRecordHistoryV2 } from '@/lib/v2/record';
import { formatDate } from '@/lib/format';
import { progressLabel } from '@/lib/record';
import type { RecordHeaderV2, HistoryEntry } from '@/lib/v2/record-view';
import type { ScheduleLine } from '@/lib/record';
import '@/components/record.css';

export const dynamic = 'force-dynamic';

const TABS = ['plan', 'schedule', 'money', 'history'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  plan: 'Plan', schedule: 'Schedule', money: 'Money', history: 'History',
};

export default async function RecordPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/record`);

  const { tab: rawTab } = await searchParams;
  // Schedule is the tab v2 populates today, so an unknown or missing ?tab= lands
  // the reader there rather than on an empty Plan panel. A valid ?tab= is still
  // honoured verbatim so a pasted `?tab=history` link opens where it says.
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as Tab) : 'schedule';

  const record = await getRecordV2(id);
  // Fail-closed (S1): a viewer who cannot see this build (not mirrored, no active
  // org, not a participant) gets a resolved-but-empty record, never a crash and
  // never another party's data.
  const name = record?.name ?? 'This build';
  const shell = await buildShellContextV2(id, name);

  // The ledger read is lazy — only the History tab pays for it.
  const history = tab === 'history' ? await getRecordHistoryV2(id) : [];

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name }}
      section="schedule"
    >
      <main className="rc">
        <RecordHeader header={record?.header ?? null} />

        <nav className="rc-tabs" aria-label="The record">
          {TABS.map((t) => (
            <Link
              key={t}
              className={`rc-tab ${t === tab ? 'is-on' : ''}`.trim()}
              href={`/projects/${id}/record?tab=${t}`}
              aria-current={t === tab ? 'page' : undefined}
            >
              {TAB_LABEL[t]}
            </Link>
          ))}
        </nav>

        {tab === 'schedule' ? (
          <ScheduleTab lines={record?.schedule ?? []} />
        ) : tab === 'history' ? (
          <HistoryTab entries={history} />
        ) : (
          <PendingTab projectId={id} tab={tab} />
        )}
      </main>
    </PortalShell>
  );
}

// ── The header: what this record IS right now ────────────────────────────────

function RecordHeader({ header }: { header: RecordHeaderV2 | null }) {
  return (
    <div className="rc-head">
      <div className="rc-head-l">
        <h1 className="rc-title">The record, live</h1>
        <p className="rc-lede">
          What was agreed, what has happened to it since, and what each of those moves cost.
        </p>
      </div>
      <div className="rc-head-r">
        {/* v2 asserts only "as agreed": nothing has been recorded against a fresh
            build, and a "deviation" needs a movement model v2 does not yet carry
            (record-view.ts). The badge stays neutral rather than claiming one. */}
        <span className="badge neutral">As agreed</span>
        {header?.baseline ? (
          <span className="cap">Measured against baseline v{header.baseline.versionNo}</span>
        ) : (
          <span className="cap">No baseline yet — nothing here is agreed until a plan is accepted.</span>
        )}
      </div>
    </div>
  );
}

// ── Tab · Schedule — the plan's dates and the latest reported progress ───────

function ScheduleTab({ lines }: { lines: ScheduleLine[] }) {
  if (lines.length === 0) {
    return <section className="rc-panel"><p className="notice">No lines to schedule yet.</p></section>;
  }
  const ordered = [...lines].sort((a, b) => a.position - b.position);

  return (
    <section className="rc-panel" aria-labelledby="rc-sched-t">
      <h2 className="rc-panel-t" id="rc-sched-t">Planned against reported</h2>
      <p className="cap">
        The dates the plan committed to, and the latest progress reported against each line.
      </p>
      <div className="rc-lines card">
        <div className="rc-linehdr">
          <span className="grp">Line</span>
          <span className="grp">Planned dates</span>
          <span className="grp">Reported</span>
        </div>
        {ordered.map((l) => (
          <div key={l.stageId} className="rc-line is-static">
            <span className="rc-line-main"><span className="rc-line-n">{l.name}</span></span>
            <span className="num cap">
              {l.plannedStartDate && l.plannedEndDate
                ? `${formatDate(l.plannedStartDate)} → ${formatDate(l.plannedEndDate)}`
                : '—'}
            </span>
            <span className="rc-sched-s">
              {/* Colour is never the only signal (FR9): the status is a word. */}
              <span className={`badge ${l.status === 'done' ? 'ok' : l.status === 'blocked' ? 'bad' : l.status === 'in_progress' ? 'warn' : 'neutral'}`}>
                {progressLabel(l.status)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Tabs pending the v2 record slice — honest, decision-neutral placeholders ──

type PendingTab = Exclude<Tab, 'schedule' | 'history'>;

const PENDING_COPY: Record<PendingTab, string> = {
  plan:
    'The line-by-line plan and the materials behind each price are being rebuilt on the v2 record. '
    + 'Until that slice lands, this build reports its plan through the Plan surface.',
  money:
    'Budget movement — scope changes and price movements — is being rebuilt on the v2 record. '
    + 'Until that slice lands, there is nothing recorded to move against on this build.',
};

function PendingTab({ projectId, tab }: { projectId: string; tab: PendingTab }) {
  return (
    <section className="rc-panel">
      <p className="notice">{PENDING_COPY[tab]}</p>
      <Link className="btn" href={`/projects/${projectId}/plan`}>Go to the plan</Link>
    </section>
  );
}

// ── Tab · History — the audit ledger, projected (who decided what, when) ──────
// LINA-363: live on v2 via listRecord. Every change to this build, newest
// first. Entries the viewer is not party to arrive redacted — the row still
// shows the WHEN, WHO and the SHAPE of the change, but the detail is withheld,
// because the ledger is one shared chain and the read must not leak another
// party's business (V7).

function HistoryTab({ entries }: { entries: HistoryEntry[] }) {
  if (entries.length === 0) {
    return (
      <section className="rc-panel">
        <p className="notice">Nothing recorded yet — this build has no history to show.</p>
      </section>
    );
  }
  return (
    <section className="rc-panel" aria-labelledby="rc-hist-t">
      <h2 className="rc-panel-t" id="rc-hist-t">Who decided what, when</h2>
      <p className="cap">
        Every recorded change to this build, newest first. Changes in a contract you are not
        party to are listed but their detail is withheld.
      </p>
      <ol className="rc-events card">
        {entries.map((e) => (
          <li key={e.seq} className="rc-event">
            <span className="rc-event-seq">{formatDate(e.occurredAt)}</span>
            <span className="rc-event-main">
              <span className="rc-event-t">{e.action}</span>
              <span className="cap">
                {e.actorRole ? `by ${e.actorRole.replace(/_/g, ' ')} · ` : ''}
                {e.objectType.replace(/_/g, ' ')}
              </span>
            </span>
            {e.redacted ? (
              <span className="badge neutral" title="A change in a contract you are not party to.">Withheld</span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
