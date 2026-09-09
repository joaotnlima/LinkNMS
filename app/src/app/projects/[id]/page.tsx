// M14 — The record, live (LINA-223).
//
// Pen: "S · M14 · The record, live" in cowork/pen/linkNMS.pen. Decision:
// ADR-0015. This is the build's HOME — the four-pillar glance a stressed owner
// reads before a single number, a progress line, and the master timeline. It is
// NOT the four-tab record at /record (D14); those tabs are reached from the
// pillars, the timeline's Compare links, and the More nav.
//
// ── WHAT THE PEN DRAWS THAT WE WILL NOT FAKE (ADR-0015 §2/§3/§5) ──────────────
// The record renders persisted data or omits it — no fixtures (LINA-57). So:
//   - SAFETY has no backing data → "Not tracked yet", muted, never a green.
//   - BUDGET shows current-vs-baseline, never a spent figure the ledger lacks.
//   - "Week X of Y" comes from the baseline plan's dates, or the line is omitted.
//   - The timeline carries no per-stage day-delta — there are no executed dates;
//     it shows reported progress against the plan instead.
import { redirect } from 'next/navigation';
import Link from 'next/link';

import { getProject, getRecord, isSignedIn } from '@/lib/api';
import { PillarPanel } from '@/components/PillarPanel';
import { PortalShell } from '@/components/PortalShell';
import { buildShellContext } from '@/server/portal-shell';
import type { ScheduleLine } from '@/lib/record';
import { weekLine, timelineTone, timelineStateLabel } from '@/lib/record-home';
import './record-home.css';

export const dynamic = 'force-dynamic';

export default async function RecordHomePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isSignedIn())) redirect(`/sign-in?next=/projects/${id}`);

  const [p, record] = await Promise.all([getProject(id), getRecord(id)]);
  const shell = await buildShellContext(id, p.name);

  const lines = [...record.tabs.schedule.lines].sort((a, b) => a.position - b.position);
  // "Week X of Y" is derived from the baseline plan's dates; null (omitted) when
  // there is no accepted baseline or no dated stage (ADR-0015 §4).
  const wl = record.baseline ? weekLine(lines, new Date()) : null;

  // The header's on-track word reads the SAME schedule pillar the tile does, so
  // the two can never disagree. green → on track; amber → the schedule moved.
  const sched = p.pillars.schedule;
  const onTrack = sched.status === 'green';

  const hasCounterparty = p.members.some((m) => m.role === 'counterparty' || m.role === 'subcontractor');

  return (
    <PortalShell
      user={shell.user}
      builds={shell.builds}
      activeBuild={{ id, name: p.name }}
      section="overview"
    >
      <main className="m14">
        <header className="m14-head">
          <div className="m14-head-badges">
            {wl ? (
              <span className="m14-week">
                <span className="m14-week-ic" aria-hidden>◷</span>
                Week {wl.week} of {wl.total}
              </span>
            ) : null}
            <span className={`m14-track ${onTrack ? 'on' : 'off'}`}>
              {onTrack ? 'On track' : 'Schedule moved'}
            </span>
          </div>
          <h1 className="m14-title">{p.name}</h1>
        </header>

        {/* FR1: a "shared" record with one party shares nothing. Owner-only, and
            only while no counterparty has joined — the honest empty state, not a
            hub row. Dropped the moment a GC/sub is on the record. */}
        {p.actingRole === 'owner' && !hasCounterparty ? (
          <Link className="m14-invite" href={`/projects/${id}/invite`}>
            <span className="m14-invite-t">Invite your general contractor</span>
            <span className="m14-invite-c">No second party on this record yet →</span>
          </Link>
        ) : null}

        <PillarPanel pillars={p.pillars} projectId={id} />

        <section className="m14-timeline-sec" aria-labelledby="m14-tl-h">
          <div className="m14-tl-head">
            <h2 id="m14-tl-h" className="m14-tl-title">Master timeline</h2>
            <Legend />
          </div>
          <Timeline projectId={id} lines={lines} />
        </section>
      </main>
    </PortalShell>
  );
}

function Legend() {
  return (
    <div className="m14-legend" aria-hidden>
      <span className="m14-lg"><span className="m14-sw plan" /> Plan</span>
      <span className="m14-lg"><span className="m14-sw actual" /> Actual</span>
      <span className="m14-lg"><span className="m14-sw closed" /> Closed</span>
    </div>
  );
}

function Timeline({ projectId, lines }: { projectId: string; lines: ScheduleLine[] }) {
  if (lines.length === 0) {
    return (
      <div className="m14-timeline">
        <p className="notice">
          No plan on this record yet. Import or agree a plan and its stages appear here.
        </p>
        <Link className="btn" href={`/projects/${projectId}/plan`}>Go to the plan</Link>
      </div>
    );
  }
  return (
    <ol className="m14-timeline">
      {lines.map((l) => (
        <TimelineRow key={l.stageId} projectId={projectId} line={l} />
      ))}
    </ol>
  );
}

function TimelineRow({ projectId, line }: { projectId: string; line: ScheduleLine }) {
  const tone = timelineTone(line.status);
  const stateLabel = timelineStateLabel(line.status);
  // Reported progress is the only "actual" the record holds — not a calendar
  // range (ADR-0015 §5). A missing percent on an in-progress line reads as 0.
  const pct = tone === 'closed' ? 100 : Math.max(0, Math.min(100, line.percent ?? 0));

  return (
    <li className="m14-row">
      <div className="m14-row-top">
        <span className="m14-row-name">{line.name}</span>
        <span className={`m14-state ${tone}`}>{stateLabel}</span>
      </div>
      <div className="m14-row-bar">
        <div className={`m14-bar ${tone}`}>
          {/* closed → full green; progress → blue plan track + orange actual fill;
              blocked → plan track + amber marker; not_started → muted plan track. */}
          {tone === 'progress' ? <span className="m14-bar-fill" style={{ width: `${pct}%` }} /> : null}
        </div>
        <Link className="m14-compare" href={`/projects/${projectId}/record/${line.stageId}`}>
          <span aria-hidden>⇄</span> Compare
        </Link>
      </div>
      {line.status === 'in_progress' && line.percent != null ? (
        <span className="m14-row-pct">{line.percent}% reported</span>
      ) : null}
    </li>
  );
}
