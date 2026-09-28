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
// The v1 page read ONE `getRecord` projection for all four tabs. On v2 (doc 22
// §3, verified against the live backend):
//
//   • Header / state + Schedule tab ← `getRecordV2` (getProject + getSchedule).
//   • History tab (audit ledger)     ← `listRecord` — LIVE as of LINA-359. The
//     V7-projected chain, newest first; out-of-scope entries render as redacted
//     rows so the chain stays complete without leaking their content.
//   • Plan (materials) + Money (movements) ← nothing yet. That Slice-B3 model is
//     being re-conceived on the v2-native model (change orders / cost lines),
//     tracked separately (LINA-362/363/364); under B2 a fresh build has neither,
//     so those two tabs render an honest "arrives with the v2 record slice" panel
//     rather than fake data. See `lib/v2/record-view.ts`.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { isSignedIn } from '@/lib/api';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContextV2 } from '@/lib/v2/shell';
import { getRecordV2, type RecordV2 } from '@/lib/v2/record';
import { formatDate } from '@/lib/format';
import { progressLabel } from '@/lib/record';
import type { RecordHeaderV2, RecordHistoryLineV2 } from '@/lib/v2/record-view';
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
          <HistoryTab lines={record?.history ?? []} />
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

// ── Tab · History — the audit ledger (LINA-359) ──────────────────────────────
// The whole chain, newest first, V7-projected: an entry the viewer may read
// carries its sentence and who acted; an out-of-scope entry is shown as a
// redacted row — that a change happened is not itself a secret, its content is.
// The row keeps its `seq` so the order is the chain's order, not a re-sort.

function HistoryTab({ lines }: { lines: RecordHistoryLineV2[] }) {
  if (lines.length === 0) {
    return (
      <section className="rc-panel">
        <p className="notice">Nothing has been recorded against this build yet.</p>
      </section>
    );
  }
  return (
    <section className="rc-panel" aria-labelledby="rc-hist-t">
      <h2 className="rc-panel-t" id="rc-hist-t">Who changed what, and when</h2>
      <p className="cap">
        Every recorded change, newest first. Entries outside your access show that a change
        happened without disclosing its content — the chain stays complete and verifiable.
      </p>
      <ol className="rc-hist">
        {lines.map((e) => (
          <li key={e.seq} className={`rc-hist-row ${e.redacted ? 'is-redacted' : ''}`.trim()}>
            <span className="rc-hist-when cap">{formatDate(e.occurredAt)}</span>
            <span className="rc-hist-what">
              {e.sentence}
              {e.redacted ? (
                <span className="badge neutral">Not visible</span>
              ) : e.actorOrgRole ? (
                <span className="cap"> · by a {e.actorOrgRole}</span>
              ) : null}
            </span>
            <span className="rc-hist-cat cap">{e.category}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── Tabs pending the v2 record slice — honest, decision-neutral placeholders ──
// Plan (materials) and Money (movements) are being re-conceived on the v2-native
// model (change orders / cost lines), tracked separately (LINA-362/363/364); the
// History tab above is live as of LINA-359.

const PENDING_COPY: Record<'plan' | 'money', string> = {
  plan:
    'The line-by-line plan and the materials behind each price are being rebuilt on the v2 record. '
    + 'Until that slice lands, this build reports its plan through the Plan surface.',
  money:
    'Budget movement — scope changes and price movements — is being rebuilt on the v2 record. '
    + 'Until that slice lands, there is nothing recorded to move against on this build.',
};

function PendingTab({ projectId, tab }: { projectId: string; tab: 'plan' | 'money' }) {
  return (
    <section className="rc-panel">
      <p className="notice">{PENDING_COPY[tab]}</p>
      <Link className="btn" href={`/projects/${projectId}/plan`}>Go to the plan</Link>
    </section>
  );
}
