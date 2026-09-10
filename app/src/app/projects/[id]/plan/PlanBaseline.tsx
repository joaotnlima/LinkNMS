'use client';

// D11 → D12 → D12a → D13, the plan proposal → review → baseline v1 surface
// (LINA-212).
//
// Pen: "Desktop — Bootstrap flow (lg)" › D11 Proposed — awaiting the owner,
// D12 Owner reviews, D12a Request changes, D13 Accepted — baseline v1.
// Contract: docs/architecture/slice-b2-plan-baseline-contract.md §5 + §7.
//
// ── WHY FOUR PEN SCREENS ARE ONE COMPONENT ───────────────────────────────────
// They are not four screens, they are one plan in four states, and which one you
// see is not a route you navigate to — it is `status` plus WHO IS LOOKING. The
// same URL shows the proposer their withdraw control and the reviewer their
// three decisions, because the record is shared: two people looking at the same
// plan must be looking at the same object, not at two screens that could drift.
// D12a is the one genuinely modal state (an editor is open), so it is a flag on
// this component rather than a page whose back button would silently discard a
// counter-proposal.
//
// ── THE AFFORDANCES ARE NOT THE PERMISSION ───────────────────────────────────
// `canWithdraw` / `canReview` decide which buttons exist. The SERVER decides who
// may act, from the session and the version row (contract §6) — a refusal comes
// back as a typed 403 and is rendered as one. Nothing here sends an actor.
//
// ── WHAT THE PEN DRAWS THAT B2 DOES NOT HAVE ─────────────────────────────────
// The mock carries per-line comments ("On 'Roof': is May realistic?"), a "Send a
// reminder" button, and a free-text WHY box on the counter-proposal. None of
// them exist on the frozen wire: `:request-changes` takes `{ stages }` and
// nothing else (§5). A box whose contents are dropped on submit is worse than no
// box — it invites the owner to put their reasoning somewhere it will not be
// found later, on a product whose promise is that the reasoning IS findable. So
// they are left out, and the reasoning has a real home already: a decision on the
// record. Noted for B3, not silently dropped.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { barGeometry, dateRange, ganttScale, preorder, type GanttScale } from '@/lib/plan-import';
import {
  PlanActionError, StageEditError,
  acceptVersion, awaitedPartyId, canReview, canWithdraw, describeEdit, diffEdits, draftOf,
  proposeVersion, rejectVersion,
  requestChanges, stageCounts, stamps, toRows, totalAfter, totalCents, withdrawVersion,
  type PlanBaselineView, type PlanVersionSummary, type PlanVersionView, type StageDraft,
  type StageEdit, type StageRow,
} from '@/lib/plan-baseline';
import { formatDateTime, moneyPrecise } from '@/lib/format';
import '@/components/plan-baseline.css';

export interface PartyRef { partyId: string; name: string; role: string }

interface Props {
  projectId: string;
  view: PlanBaselineView;
  /** The signed-in party, from the session server-side. Never sent in a body. */
  actorPartyId: string | null;
  parties: PartyRef[];
}

type Busy = null | 'withdraw' | 'accept' | 'reject' | 'request-changes' | 'propose';

export function PlanBaseline({ projectId, view, actorPartyId, parties }: Props) {
  const router = useRouter();
  const { baseline, current, history } = view;

  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const rows = useMemo(() => (current ? toRows(current.stages) : []), [current]);
  const scale = useMemo(() => ganttScale(rows), [rows]);

  // The drafts start as exactly what the current version says, seeded when the
  // editor opens rather than held across it: after a successful request-changes
  // the server hands back a NEW version, and a draft carried over would be an
  // edit against a plan that has already dropped into history.
  const [drafts, setDrafts] = useState<Record<string, StageDraft>>({});
  const openEditor = () => {
    setDrafts(Object.fromEntries(preorder(rows).map(({ node }) => [node.id, draftOf(node)])));
    setEditing(true);
    setRejecting(false);
    setError(null);
  };

  const nameOf = (partyId: string | null | undefined) =>
    (partyId && parties.find((p) => p.partyId === partyId)?.name) || 'Unknown party';

  async function run(kind: Exclude<Busy, null>, action: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
      setEditing(false);
      setRejecting(false);
      setReason('');
      // The server is the authority on what the plan is now — re-read it rather
      // than patching a local copy, so the screen can never show a state the
      // record does not hold.
      router.refresh();
    } catch (err) {
      setError(err instanceof PlanActionError || err instanceof StageEditError
        ? err.message
        : 'That did not go through. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const mayWithdraw = current ? canWithdraw(current, actorPartyId) : false;
  const mayReview = current ? canReview(current, actorPartyId) : false;
  // A draft is surfaced by the server to its author ONLY (LINA-230); the gate is
  // courtesy, not the check — :propose refuses anyone but the drafter server-side.
  const isDraft = current?.status === 'draft';
  const mayPropose = isDraft && !!actorPartyId && actorPartyId === current!.proposedByPartyId;

  return (
    <div className="pb">
      {baseline ? (
        <BaselineBanner
          baseline={baseline}
          version={history.find((h) => h.id === baseline.planVersionId) ?? null}
          nameOf={nameOf}
        />
      ) : null}

      {current ? (
        <>
          {isDraft
            ? <DraftBanner />
            : <ProposalBanner current={current} mayReview={mayReview} nameOf={nameOf} awaited={awaitedName(current, parties, nameOf)} />}

          <div className="pb-head">
            <h1 className="pb-title">{isDraft ? 'Plan · draft' : `Plan · version ${current.versionNo}`}</h1>
            <StatusBadge status={current.status} mine={mayReview} />
          </div>

          {/* D12a: the pre-edit version stays rendered, read-only, and the editor
              opens beneath it. The original is not replaced by the counter — that
              is the whole point of forking a version instead of editing one. */}
          <PlanTable
            rows={rows}
            scale={scale}
            caption={editing ? `Version ${current.versionNo}, as proposed — unchanged` : undefined}
            dimmed={editing}
          />

          {editing ? (
            <ChangeEditor
              rows={rows}
              drafts={drafts}
              onChange={(id, patch) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }))}
              busy={busy === 'request-changes'}
              onCancel={() => { setEditing(false); setError(null); }}
              onSubmit={() => run('request-changes', async () => {
                const edits = diffEdits(rows, drafts);
                if (edits.length === 0) {
                  throw new StageEditError('', 'Change a date or a value first — this sends back what you are asking for.');
                }
                await requestChanges(projectId, current.id, edits);
              })}
            />
          ) : null}

          {isDraft
            ? <DraftPanel />
            : <AcceptancePanel current={current} parties={parties} nameOf={nameOf} />}

          {error ? <p className="form-error" role="alert">{error}</p> : null}

          {isDraft && mayPropose ? (
            <div className="pb-actions">
              <button type="button" className="btn primary" disabled={busy !== null}
                onClick={() => run('propose', () => proposeVersion(projectId, current.id))}>
                {busy === 'propose' ? 'Sending…' : 'Send for approval'}
              </button>
              <Link className="btn" href={`/projects/${projectId}/plan/build`}>Keep editing</Link>
            </div>
          ) : null}

          {!isDraft && !editing ? (
            <div className="pb-actions">
              {mayReview ? (
                <>
                  <button type="button" className="btn primary" disabled={busy !== null}
                    onClick={() => run('accept', () => acceptVersion(projectId, current.id))}>
                    {busy === 'accept' ? 'Accepting…' : 'Accept the plan'}
                  </button>
                  <button type="button" className="btn" disabled={busy !== null} onClick={openEditor}>
                    Request changes
                  </button>
                  <button type="button" className="btn reject" disabled={busy !== null}
                    onClick={() => setRejecting((r) => !r)}>
                    Reject
                  </button>
                </>
              ) : null}
              {mayWithdraw ? (
                <button type="button" className="btn reject" disabled={busy !== null}
                  onClick={() => run('withdraw', () => withdrawVersion(projectId, current.id))}>
                  {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw the proposal'}
                </button>
              ) : null}
            </div>
          ) : null}

          {rejecting && mayReview && !editing ? (
            <div className="pb-reject card">
              <label className="pb-label" htmlFor="pb-reason">Why are you rejecting it? (optional)</label>
              <textarea
                id="pb-reason" className="pb-textarea" rows={3} maxLength={2000}
                value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="This is recorded with the rejection and stays on the record."
              />
              <p className="cap">
                Rejecting ends this version. If you want the dates or the numbers moved instead,
                ask for changes — that keeps the plan alive and sends back exactly what you changed.
              </p>
              <div className="pb-actions">
                <button type="button" className="btn reject" disabled={busy !== null}
                  onClick={() => run('reject', () => rejectVersion(projectId, current.id, reason))}>
                  {busy === 'reject' ? 'Rejecting…' : 'Reject this version'}
                </button>
                <button type="button" className="btn" disabled={busy !== null}
                  onClick={() => { setRejecting(false); setReason(''); }}>
                  Keep it open
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <HistoryStrip history={history} baselineVersionId={baseline?.planVersionId ?? null} nameOf={nameOf} />
    </div>
  );
}

// ── D13 · accepted, frozen ───────────────────────────────────────────────────

function BaselineBanner({
  baseline, version, nameOf,
}: {
  baseline: NonNullable<PlanBaselineView['baseline']>;
  version: PlanVersionSummary | null;
  nameOf: (id: string | null | undefined) => string;
}) {
  // BOTH stamps, individually attributed and individually timed (contract §7).
  // One combined "accepted on 5 Mar" would be the summary of a fact rather than
  // the fact: the product's claim is that each party stamped this exact version,
  // and that claim is only as good as the two rows below.
  const s = version ? stamps(version) : { proposed: null, accepted: null };
  return (
    <section className="pb-frozen" aria-labelledby="pb-frozen-t">
      <p className="pb-frozen-t" id="pb-frozen-t">
        Plan accepted by both parties — baseline v{baseline.versionNo} is set
      </p>
      <p className="cap">
        Frozen {formatDateTime(baseline.frozenAt)}. Nothing in it is edited from here — it is
        changed, and every change is measured against this.
      </p>
      <ul className="pb-stamps">
        {s.proposed ? (
          <li className="pb-stamp">
            <span className="pb-stamp-who">{nameOf(s.proposed.partyId)}</span>
            <span className="cap">{roleWord(s.proposed.role)} · proposed</span>
            <span className="num pb-stamp-at">{formatDateTime(s.proposed.stampedAt)}</span>
          </li>
        ) : null}
        {s.accepted ? (
          <li className="pb-stamp">
            <span className="pb-stamp-who">{nameOf(s.accepted.partyId)}</span>
            <span className="cap">{roleWord(s.accepted.role)} · accepted</span>
            <span className="num pb-stamp-at">{formatDateTime(s.accepted.stampedAt)}</span>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

// ── D11 / D12 · the banner that says whose move it is ────────────────────────

function ProposalBanner({
  current, mayReview, nameOf, awaited,
}: {
  current: PlanVersionView;
  mayReview: boolean;
  nameOf: (id: string | null | undefined) => string;
  awaited: string | null;
}) {
  if (current.status !== 'proposed') return null;
  const proposer = nameOf(current.proposedByPartyId);
  return (
    <section className={`pb-banner ${mayReview ? 'is-yours' : ''}`.trim()} role="status">
      <p className="pb-banner-t">
        {mayReview
          ? `${proposer} proposed a plan — it is waiting on you`
          : awaited
            ? `Sent to ${awaited} for acceptance`
            : 'Proposed — awaiting acceptance'}
      </p>
      <p className="pb-banner-b">
        {mayReview
          ? 'Read it before you accept. Asking for changes is not a rejection — it sends back exactly what you changed, as a new version.'
          : 'Until it is accepted, this plan is a proposal. It is visible in full, and nothing in it counts as agreed.'}
      </p>
    </section>
  );
}

function StatusBadge({ status, mine }: { status: PlanVersionSummary['status']; mine: boolean }) {
  const label = status === 'draft'
    ? 'Draft — not sent'
    : status === 'proposed'
      ? (mine ? 'Awaiting your decision' : 'Proposed')
      : status[0].toUpperCase() + status.slice(1);
  const tone = status === 'accepted' ? 'ok' : status === 'proposed' ? 'warn' : 'neutral';
  return <span className={`badge ${tone}`}>{label}</span>;
}

// ── Draft · saved, private, not yet sent (LINA-230) ──────────────────────────
// The author's own view of a saved-but-unproposed plan. The whole point of the
// founder's feedback: this is visible ONLY to the author, counts as nothing
// agreed, and requests nothing — until they deliberately Send for approval.

function DraftBanner() {
  return (
    <section className="pb-banner" role="status">
      <p className="pb-banner-t">Saved as a draft — only you can see it</p>
      <p className="pb-banner-b">
        This is your private working copy. The other party cannot see it and no approval has been
        requested. Keep editing as much as you like; when it is ready, send it for approval.
      </p>
    </section>
  );
}

function DraftPanel() {
  return (
    <section className="pb-acc card" aria-labelledby="pb-draft-t">
      <h2 className="pb-acc-t" id="pb-draft-t">What happens when you send it</h2>
      <div className="pb-onaccept">
        <p className="grp">Send for approval</p>
        <ul>
          <li>The plan becomes version 1 and the other party can see and review it.</li>
          <li>Your authorship is stamped by name and time on the shared record.</li>
          <li>Until then nothing here is sent, and nothing counts as agreed.</li>
        </ul>
      </div>
    </section>
  );
}

// ── The plan table — the B1 preview components, reused ───────────────────────

function PlanTable({
  rows, scale, caption, dimmed,
}: {
  rows: StageRow[];
  scale: GanttScale | null;
  caption?: string;
  dimmed?: boolean;
}) {
  const flat = preorder(rows);
  const total = totalCents(rows);
  const counts = stageCounts(rows);

  if (flat.length === 0) {
    return <p className="notice">This version has no stages on it.</p>;
  }

  return (
    <div className={`pi-plan card ${dimmed ? 'is-under' : ''}`.trim()}>
      {caption ? <p className="pb-caption">{caption}</p> : null}
      <div className="pi-planhdr">
        <span className="grp pi-cell-name">Action / sub-action</span>
        <span className="grp pi-cell-dates">Dates</span>
        <span className="grp pb-cell-value">Value</span>
        <span className="grp pi-cell-gantt" aria-hidden="true">
          {scale ? scale.months.map((m) => <span key={m.key} className="pi-month">{m.label}</span>) : null}
        </span>
      </div>
      {flat.map(({ node, depth }) => {
        const bar = scale ? barGeometry(node, scale) : null;
        return (
          <div key={node.id} className={`pi-planrow ${depth ? 'is-sub' : ''}`.trim()}>
            <span className="pi-cell-name">{node.name}</span>
            <span className="pi-cell-dates num">{dateRange(node)}</span>
            <span className="pb-cell-value num">
              {node.costCents == null ? <span className="pi-dash">—</span> : moneyPrecise(node.costCents)}
            </span>
            <span className="pi-cell-gantt">
              {/* Decoration for a fact the Dates column already states in words —
                  colour is never the only signal (FR9), applied to a chart. */}
              {bar ? <span className="pi-bar" aria-hidden="true" style={{ left: `${bar.left}%`, width: `${bar.width}%` }} /> : null}
            </span>
          </div>
        );
      })}
      <div className="pb-total">
        <span className="cap">
          {counts.actions} action{counts.actions === 1 ? '' : 's'} · {counts.subActions} sub-action
          {counts.subActions === 1 ? '' : 's'}
        </span>
        <span className="pb-total-r">
          <span className="grp">Plan value</span>
          {/* Σ of what the stages say, and NOT the budget: B2 freezes the plan,
              B3 owns the money (contract §8). Unpriced when nothing is priced —
              "$0.00" would be a claim the record has not been given. */}
          <span className="num pb-total-n">{total == null ? 'Not priced' : moneyPrecise(total)}</span>
        </span>
      </div>
    </div>
  );
}

// ── D12a · the editable overlay, dates and money only ────────────────────────

function ChangeEditor({
  rows, drafts, onChange, onSubmit, onCancel, busy,
}: {
  rows: StageRow[];
  drafts: Record<string, StageDraft>;
  onChange: (stageId: string, patch: Partial<StageDraft>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const flat = preorder(rows);
  // The diff is recomputed as you type, and a half-typed amount is not an error
  // yet — it simply does not count as a change until it parses. The refusal
  // happens on submit, where it can be acted on.
  const edits = useMemo<StageEdit[]>(() => {
    try { return diffEdits(rows, drafts); } catch { return []; }
    }, [rows, drafts]);
  const byId = new Map(edits.map((e) => [e.stageId, e]));
  const before = totalCents(rows);
  const after = totalAfter(rows, edits);
  const rowById = new Map(flat.map(({ node }) => [node.id, node]));

  return (
    <section className="pb-editor card" aria-labelledby="pb-editor-t">
      <div className="pb-editor-hd">
        <h2 className="pb-editor-t" id="pb-editor-t">Your proposed change</h2>
        <p className="cap">
          Dates and values only. What each action IS — its name, where it sits in the plan — is the
          contractor&apos;s; you are proposing when it runs and what it costs.
        </p>
      </div>

      {flat.map(({ node, depth }) => {
        const d = drafts[node.id] ?? draftOf(node);
        const edit = byId.get(node.id);
        return (
          <div key={node.id} className={`pb-editrow ${depth ? 'is-sub' : ''} ${edit ? 'is-changed' : ''}`.trim()}>
            <span className="pb-edit-name">{node.name}</span>
            <label className="pb-field">
              <span className="grp">Start</span>
              <input type="date" className="pb-input" value={d.start}
                onChange={(e) => onChange(node.id, { start: e.target.value })} />
            </label>
            <label className="pb-field">
              <span className="grp">End</span>
              <input type="date" className="pb-input" value={d.end}
                onChange={(e) => onChange(node.id, { end: e.target.value })} />
            </label>
            <label className="pb-field">
              <span className="grp">Value</span>
              <input type="text" inputMode="decimal" className="pb-input num" value={d.cost}
                placeholder="—" onChange={(e) => onChange(node.id, { cost: e.target.value })} />
            </label>
            {/* The original, on the row it belongs to. "was" is the whole D12a
                idea in one word: the plan you are answering stays legible while
                you answer it. */}
            {edit ? (
              <p className="pb-was cap">
                was {dateRange(node)} · {node.costCents == null ? '—' : moneyPrecise(node.costCents)}
              </p>
            ) : null}
          </div>
        );
      })}

      <div className="pb-summary">
        <p className="grp">What you changed</p>
        {edits.length === 0 ? (
          <p className="cap">Nothing yet. Move a date or a value and it appears here before it is sent.</p>
        ) : (
          <ul className="pb-changelist">
            {edits.map((e) => {
              const row = rowById.get(e.stageId);
              if (!row) return null;
              const s = describeEdit(row, e);
              return (
                <li key={e.stageId}>
                  <span className="pb-change-name">{row.name}</span>
                  {s.dates ? (
                    <span className="cap num">
                      dates: {dateRange(s.dates.from)} ⟶ {dateRange(s.dates.to)}
                    </span>
                  ) : null}
                  {s.value ? (
                    <span className="cap num">
                      value: {s.value.fromCents == null ? '—' : moneyPrecise(s.value.fromCents)} ⟶{' '}
                      {moneyPrecise(s.value.toCents)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {before != null && after != null && after !== before ? (
          <p className="pb-delta num">
            Plan value {moneyPrecise(before)} → {moneyPrecise(after)}{' '}
            <span className={after > before ? 'is-up' : 'is-down'}>
              ({after > before ? '+' : '−'}{moneyPrecise(Math.abs(after - before))})
            </span>
          </p>
        ) : null}
      </div>

      <p className="cap">
        This does not reject the plan. Sending it back creates the next version, authored by you —
        the one above drops into the history as superseded and stays readable.
      </p>

      <div className="pb-actions">
        <button type="button" className="btn primary" disabled={busy || edits.length === 0} onClick={onSubmit}>
          {busy ? 'Sending…' : 'Send back the changes'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>Discard my changes</button>
      </div>
    </section>
  );
}

// ── The acceptance drawer (D11/D12) ──────────────────────────────────────────

function AcceptancePanel({
  current, parties, nameOf,
}: {
  current: PlanVersionView;
  parties: PartyRef[];
  nameOf: (id: string | null | undefined) => string;
}) {
  const s = stamps(current);
  const stampFor = (partyId: string) => current.acceptances.find((a) => a.partyId === partyId) ?? null;

  return (
    <section className="pb-acc card" aria-labelledby="pb-acc-t">
      <h2 className="pb-acc-t" id="pb-acc-t">Acceptance</h2>
      <ul className="pb-parties">
        {parties.map((p) => {
          const stamp = stampFor(p.partyId);
          return (
            <li key={p.partyId} className="pb-party">
              <span className="pb-party-n">{nameOf(p.partyId)}</span>
              <span className="cap">
                {roleWord(p.role)}
                {p.partyId === current.proposedByPartyId ? ' · proposed it' : ''}
              </span>
              <span className="pb-party-s">
                {stamp ? (
                  <>
                    <span className={stamp.kind === 'accepted' ? 'is-ok' : 'is-wait'}>
                      {stamp.kind === 'accepted' ? 'Accepted' : 'Proposed'}
                    </span>
                    <span className="cap num">{formatDateTime(stamp.stampedAt)}</span>
                  </>
                ) : (
                  <span className="is-wait">Awaiting</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {!s.accepted ? (
        <div className="pb-onaccept">
          <p className="grp">What happens on acceptance</p>
          <ul>
            <li>Version {current.versionNo} is frozen as the baseline.</li>
            <li>Both acceptances are stamped by name and time.</li>
            <li>Every later change is recorded against it, never over it.</li>
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// ── The history strip — the negotiation stays visible (§7) ───────────────────

function HistoryStrip({
  history, baselineVersionId, nameOf,
}: {
  history: PlanVersionSummary[];
  baselineVersionId: string | null;
  nameOf: (id: string | null | undefined) => string;
}) {
  if (history.length === 0) return null;
  // Newest first: the strip answers "how did we get here", and the last thing
  // that happened is the part of that answer being looked for. History is the
  // shared record only — every entry is numbered (a draft is never here), so the
  // ?? 0 is just to satisfy the number | null type (LINA-230).
  const ordered = [...history].sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0));
  return (
    <section className="pb-history" aria-labelledby="pb-history-t">
      <h2 className="pb-history-t grp" id="pb-history-t">The record so far</h2>
      <ol className="pb-versions">
        {ordered.map((v) => {
          const s = stamps(v);
          return (
            <li key={v.id} className={`pb-version is-${v.status}`}>
              <span className="pb-version-n num">v{v.versionNo}</span>
              <span className="pb-version-b">
                <span className="pb-version-t">
                  {statusSentence(v.status)}
                  {v.id === baselineVersionId ? ' · baseline' : ''}
                </span>
                <span className="cap">
                  proposed by {nameOf(v.proposedByPartyId)} · {formatDateTime(v.createdAt)}
                  {s.accepted ? ` · accepted by ${nameOf(s.accepted.partyId)} ${formatDateTime(s.accepted.stampedAt)}` : ''}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="cap">
        Withdrawn, rejected and superseded versions stay here on purpose. The disagreement is part
        of the record, not something the record tidies away.
      </p>
    </section>
  );
}

function statusSentence(status: PlanVersionSummary['status']): string {
  switch (status) {
    case 'accepted': return 'Accepted and frozen';
    case 'superseded': return 'Superseded — changes were requested against it';
    case 'withdrawn': return 'Withdrawn by the party that proposed it';
    case 'rejected': return 'Rejected';
    default: return 'Proposed';
  }
}

/** The role as the parties call themselves. `null` is an honest gap, never a guess. */
function roleWord(role: string | null): string {
  if (role === 'owner') return 'Owner';
  if (role === 'counterparty') return 'General contractor';
  if (role === 'subcontractor') return 'Trade';
  return 'Party';
}

function awaitedName(
  current: PlanVersionView,
  parties: PartyRef[],
  nameOf: (id: string | null | undefined) => string,
): string | null {
  // Derived from the STAMPS, not from the roles — they swap on a fork (§1), so
  // "the owner is the reviewer" is true of v1 only.
  const id = awaitedPartyId(current, parties);
  return id ? nameOf(id) : null;
}
