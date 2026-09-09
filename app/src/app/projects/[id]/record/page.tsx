// D14 — The record, live (LINA-218).
//
// Pen: "Desktop — Bootstrap flow (lg)" › D14. Contract:
// docs/architecture/slice-b3-live-record-materials-contract.md §3a + §5.
//
// ── FOUR TABS, FOUR URLS, ONE READ ───────────────────────────────────────────
// The tabs are LINKS carrying `?tab=`, not client state. This screen is the
// product's answer to "who decided this, when, and how much did it move the
// budget" — an answer you send to someone. `?tab=money` survives being pasted
// into an email; `useState` does not, and a lookup you cannot hand to the other
// party is half a lookup. The whole record arrives in ONE read (route 1 embeds
// the MoneyView as its Money tab), so switching tabs re-renders a projection the
// server already computed rather than costing a new round trip per tab.
//
// ── WHAT IS NOT HERE ─────────────────────────────────────────────────────────
// `closed_and_verified` — the pen's third line state. The service DECLINES to
// emit it in v1: it needs the deferred `stage_verified` stamp (contract §7), and
// deriving "verified" on the front end from `progress = done` would be the UI
// inventing a verification nobody performed. The badge legend says so out loud
// rather than the state quietly never appearing.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { getBuild, getRecord, isSignedIn } from '@/lib/api';
import { directoryOf } from '@/lib/view';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import { MoneyMovement } from '@/components/MoneyMovement';
import { formatDate, formatDateTime, moneyPrecise, delta } from '@/lib/format';
import {
  compareDelta, eventSentence, progressLabel, reconcile, stateLabel, stateTone,
  type RecordHistoryEvent, type RecordLine, type RecordView, type ScheduleLine,
} from '@/lib/record';
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
  searchParams: Promise<{ tab?: string; compare?: string }>;
}) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}/record`);

  const { tab: rawTab, compare } = await searchParams;
  // An unknown ?tab= falls back to Plan rather than 404ing: a mistyped tab in a
  // pasted link should still land the reader on the record.
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as Tab) : 'plan';
  const comparing = compare === '1';

  const [build, record] = await Promise.all([getBuild(id), getRecord(id)]);
  const shell = await buildShellContext(id, build.name);

  const directory = directoryOf(build);
  const nameOf = (partyId: string | null | undefined) =>
    (partyId && directory.get(partyId)?.name) || 'Unknown party';
  const lineNames = new Map(record.tabs.plan.lines.map((l) => [l.stageId, l.name]));
  const lineNameOf = (stageId: string) => lineNames.get(stageId) ?? null;

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: build.name }}
      section="schedule"
    >
      <main className="rc">
        <RecordHeader record={record} />

        <nav className="rc-tabs" aria-label="The record">
          {TABS.map((t) => (
            <Link
              key={t}
              className={`rc-tab ${t === tab ? 'is-on' : ''}`.trim()}
              href={`/projects/${id}/record?tab=${t}${comparing ? '&compare=1' : ''}`}
              aria-current={t === tab ? 'page' : undefined}
            >
              {TAB_LABEL[t]}
            </Link>
          ))}
        </nav>

        {tab === 'plan' ? (
          <PlanTab projectId={id} lines={record.tabs.plan.lines} comparing={comparing} />
        ) : null}
        {tab === 'schedule' ? <ScheduleTab lines={record.tabs.schedule.lines} /> : null}
        {tab === 'money' ? (
          <MoneyMovement projectId={id} view={record.tabs.money} nameOf={nameOf} lineNameOf={lineNameOf} />
        ) : null}
        {tab === 'history' ? <HistoryTab events={record.tabs.history.events} nameOf={nameOf} /> : null}
      </main>
    </PortalShell>
  );
}

// ── The header: what this record IS right now ────────────────────────────────

function RecordHeader({ record }: { record: RecordView }) {
  return (
    <div className="rc-head">
      <div className="rc-head-l">
        <h1 className="rc-title">The record, live</h1>
        <p className="rc-lede">
          What was agreed, what has happened to it since, and what each of those moves cost.
        </p>
      </div>
      <div className="rc-head-r">
        <span className={`badge ${stateTone(record.state)}`}>{stateLabel(record.state)}</span>
        {record.baseline ? (
          <span className="cap">
            Measured against baseline v{record.baseline.versionNo}, frozen{' '}
            {formatDate(record.baseline.frozenAt)}
          </span>
        ) : (
          // Without a baseline there is nothing to deviate FROM. Saying so is the
          // honest reading; a green "as agreed" badge over an unagreed plan would
          // be the record claiming an agreement that has not happened.
          <span className="cap">No baseline yet — nothing here is agreed until a plan is accepted.</span>
        )}
      </div>
    </div>
  );
}

// ── Tab 1 · Plan — the baseline WBS, its materials, its state ────────────────

function PlanTab({
  projectId, lines, comparing,
}: {
  projectId: string;
  lines: RecordLine[];
  comparing: boolean;
}) {
  if (lines.length === 0) {
    return (
      <section className="rc-panel">
        <p className="notice">
          No plan lines on this record yet. Import or agree a plan and it appears here.
        </p>
        <Link className="btn" href={`/projects/${projectId}/plan`}>Go to the plan</Link>
      </section>
    );
  }

  const ordered = [...lines].sort((a, b) => a.position - b.position);

  return (
    <section className="rc-panel" aria-labelledby="rc-plan-t">
      <div className="rc-panel-hd">
        <h2 className="rc-panel-t" id="rc-plan-t">The plan, as agreed and as it stands</h2>
        {/* Compare is a URL toggle for the same reason the tabs are: "here is the
            line, planned against actual" is precisely the thing you send someone.
            It stays available on EVERY line including settled ones (§3a) — a line
            that stops being auditable the moment it closes is not a record. */}
        <Link
          className={`btn rc-compare ${comparing ? 'is-on' : ''}`.trim()}
          href={`/projects/${projectId}/record?tab=plan${comparing ? '' : '&compare=1'}`}
          aria-pressed={comparing}
        >
          {comparing ? 'Hide compare' : 'Compare planned vs now'}
        </Link>
      </div>

      <div className="rc-lines card">
        <div className="rc-linehdr">
          <span className="grp">Line</span>
          <span className="grp">State</span>
          <span className="grp rc-cell-n">{comparing ? 'Planned' : 'Value now'}</span>
          {comparing ? <span className="grp rc-cell-n">Now</span> : null}
          {comparing ? <span className="grp rc-cell-n">Moved</span> : null}
        </div>
        {ordered.map((line) => (
          <LineRow key={line.stageId} projectId={projectId} line={line} comparing={comparing} />
        ))}
      </div>

      <p className="cap">
        <strong>As agreed</strong> — nothing has moved this line since the baseline.{' '}
        <strong>Deviation</strong> — a material movement has been recorded against it.{' '}
        A third state, <em>closed and verified</em>, is drawn in the design but is not recorded
        yet: it needs a verification stamp the record does not carry, so it is not claimed here.
      </p>
    </section>
  );
}

function LineRow({
  projectId, line, comparing,
}: {
  projectId: string;
  line: RecordLine;
  comparing: boolean;
}) {
  const moved = compareDelta(line);
  const d = delta(moved);
  const rec = reconcile(line);

  return (
    <Link className="rc-line" href={`/projects/${projectId}/record/${line.stageId}`}>
      <span className="rc-line-main">
        <span className="rc-line-n">{line.name}</span>
        <span className="cap">
          {line.trade ? `${line.trade} · ` : ''}
          {line.materials.length === 0
            ? 'no material breakdown yet'
            : `${line.materials.length} material line${line.materials.length === 1 ? '' : 's'} behind the price`}
        </span>
        {/* The advisory reconciliation (§7): surfaced as a soft mismatch, never
            as a state and never as an error. A line may carry a planned cost with
            no breakdown, and that is not a defect. */}
        {rec.kind === 'mismatch' && rec.materialsCents != null ? (
          <span className="cap rc-soft">
            Materials add up to {moneyPrecise(rec.materialsCents)} against a planned{' '}
            {moneyPrecise(line.plannedCostCents)} — worth a look, not a problem in itself.
          </span>
        ) : null}
      </span>

      <span className={`badge ${stateTone(line.state)}`}>{stateLabel(line.state)}</span>

      {comparing ? (
        <>
          <span className="num rc-cell-n">{moneyPrecise(line.compare.plannedCostCents)}</span>
          <span className="num rc-cell-n">{moneyPrecise(line.compare.currentValueCents)}</span>
          <span className={`num rc-cell-n delta ${d.dir}`}>{d.text}</span>
        </>
      ) : (
        <span className="num rc-cell-n">{moneyPrecise(line.currentValueCents)}</span>
      )}
    </Link>
  );
}

// ── Tab 2 · Schedule — planned against executed ──────────────────────────────

function ScheduleTab({ lines }: { lines: ScheduleLine[] }) {
  if (lines.length === 0) {
    return <section className="rc-panel"><p className="notice">No lines to schedule yet.</p></section>;
  }
  const ordered = [...lines].sort((a, b) => a.position - b.position);

  return (
    <section className="rc-panel" aria-labelledby="rc-sched-t">
      <h2 className="rc-panel-t" id="rc-sched-t">Planned against executed</h2>
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
              {/* Colour is never the only signal (FR9): the status is a word,
                  and the percentage is a second word beside it. */}
              <span className={`badge ${l.status === 'done' ? 'ok' : l.status === 'blocked' ? 'bad' : l.status === 'in_progress' ? 'warn' : 'neutral'}`}>
                {progressLabel(l.status)}
              </span>
              {l.percent != null ? <span className="cap num">{l.percent}%</span> : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Tab 4 · History — the chain, read-only ───────────────────────────────────

function HistoryTab({
  events, nameOf,
}: {
  events: RecordHistoryEvent[];
  nameOf: (partyId: string | null | undefined) => string;
}) {
  if (events.length === 0) {
    return <section className="rc-panel"><p className="notice">Nothing has been recorded yet.</p></section>;
  }
  // Newest first: "what just happened" is the question this tab is opened with.
  // The seq is printed on every row so the underlying order stays checkable
  // against the audit trail, which shows the same events ascending.
  const ordered = [...events].sort((a, b) => b.seq - a.seq);

  return (
    <section className="rc-panel" aria-labelledby="rc-hist-t">
      <h2 className="rc-panel-t" id="rc-hist-t">Everything that happened, in order</h2>
      <p className="cap">
        Read-only, and read-only on purpose: this is the hash-chained ledger, not a feed. Nothing
        here can be edited by anyone, including us.
      </p>
      <ol className="rc-events card">
        {ordered.map((e) => (
          <li key={e.eventId} className="rc-event">
            <span className="rc-event-seq num">#{e.seq}</span>
            <span className="rc-event-main">
              <span className="rc-event-t">{eventSentence(e.type)}</span>
              <span className="cap">
                {nameOf(e.actorPartyId)} · {formatDateTime(e.occurredAt)}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
