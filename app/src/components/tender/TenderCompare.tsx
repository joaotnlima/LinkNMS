'use client';

// Compare & award, side by side (PRD-02 B4, T-14..T-18). Every bid that has
// landed is a column — no shortlist needed (T-17) — with Total, Duration, Can
// start, Valid until, Lines unpriced, Files, then Pick. Figures exactly as
// quoted: no totals row, no averages, no ranking (T-14). The plan window sits
// beside the columns and a bid that does not fit it is flagged (T-15). The
// award confirmation states its consequences (T-16) and calls the same
// awardRfp as the workspace, so the domain events and records are identical.
// Amounts follow the money permission (D-07): absent → "—".

import { useState, type ReactNode } from 'react';

import { awardAction } from '../procurement-actions';
import type { TenderFollow as FollowData } from '@/lib/v2/tender-flow';
import {
  awardConsequences, compareColumns, fmtShort, isLanded, planWindowNote, type CompareColumn,
  type V2TenderWindow,
} from '@/lib/v2/tender-flow-view';
import { awardBlockedReason, type V2Rfp } from '@/lib/v2/tendering-view';
import { TenderStepper } from './TenderBits';

const ROWS: Array<[string, (c: CompareColumn) => string, ((c: CompareColumn) => boolean)?]> = [
  ['Total', (c) => c.total],
  ['Duration', (c) => c.duration, (c) => c.durationFits === false],
  ['Can start', (c) => c.canStart, (c) => c.startFits === false],
  ['Valid until', (c) => c.validUntil],
  ['Lines unpriced', (c) => String(c.linesUnpriced), (c) => c.linesUnpriced > 0],
  ['Files', (c) => (c.files ? `${c.files} ${c.files === 1 ? 'file' : 'files'}` : '—')],
];

export function TenderCompare({
  rfp, data, window, taskName, canIssue, onAwarded,
}: {
  rfp: V2Rfp;
  data: FollowData | null;
  window: V2TenderWindow | null;
  taskName: string;
  canIssue: boolean;
  /** After a successful award: the caller re-reads the RFP and the plan. */
  onAwarded: () => void;
}) {
  const lanes = data?.lanes ?? [];
  const cols = compareColumns(lanes, window);
  const [picked, setPicked] = useState<string | null>(rfp.awarded_proposal_id ?? null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decided = rfp.status === 'awarded';
  const winnerLane = lanes.find((l) => l.proposal_id === picked) ?? null;
  const winner = cols.find((c) => c.proposalId === picked) ?? null;
  const blocked = awardBlockedReason(rfp, lanes, winnerLane);

  const award = async () => {
    if (!picked) return;
    setBusy(true); setError(null);
    const res = await awardAction(rfp.id, picked);
    setBusy(false);
    setConfirming(false);
    if (!res.ok) { setError(res.message); return; }
    onAwarded();
  };

  const grid = { gridTemplateColumns: `110px repeat(${Math.max(cols.length, 1)}, minmax(110px, 1fr))` };
  const pk = (c: CompareColumn) => (c.proposalId === picked ? ' pk' : '');

  return (
    <div className="tnd" aria-label="Compare and award">
      <TenderStepper rfp={rfp} proposalsIn={lanes.filter(isLanded).length} winnerName={winner?.name ?? null} />
      <p className="tnd-note is-strong">
        {rfp.closed_at ? `Bidding closed on ${fmtShort(rfp.closed_at)}. ` : ''}
        Figures are shown as each contractor quoted them — no totals, averages or ranking.
      </p>
      {error ? <p className="tnd-err" role="alert">{error}</p> : null}

      {cols.length === 0 ? (
        <p className="tnd-note">{data ? 'No bid came in.' : 'Loading the bids…'}</p>
      ) : (
        <div className="tnd-cmp-wrap">
          <div className="tnd-cmp" style={grid} role="table" aria-label="Proposals side by side">
            <span className="l" role="columnheader" />
            {cols.map((c) => (
              <span key={c.proposalId} role="columnheader" className={`hd${pk(c)}`}>
                {c.name}{c.byEmail ? ' · by email' : ''}{c.awarded ? ' · awarded' : ''}
              </span>
            ))}
            {ROWS.map(([label, value, warn]) => (
              <Row key={label} label={label}>
                {cols.map((c) => {
                  const flagged = warn?.(c) ?? false;
                  return (
                    <span key={c.proposalId} role="cell" className={`${label === 'Total' ? 'n' : ''}${pk(c)}${flagged ? ' nofit' : ''}`}
                      title={flagged && label !== 'Lines unpriced' ? "Doesn't fit the plan window" : undefined}>
                      {value(c)}{flagged && label !== 'Lines unpriced' ? ' · doesn’t fit' : ''}
                    </span>
                  );
                })}
              </Row>
            ))}
            {!decided && canIssue ? (
              <Row label="" last>
                {cols.map((c) => (
                  <span key={c.proposalId} role="cell" className={`last${pk(c)}`}>
                    {c.live ? (
                      <button type="button" className={`btn sm${picked === c.proposalId ? ' primary' : ''}`}
                        aria-pressed={picked === c.proposalId}
                        onClick={() => { setPicked(c.proposalId); setConfirming(false); }}>
                        {picked === c.proposalId ? 'Picked' : 'Pick'}
                      </button>
                    ) : null}
                  </span>
                ))}
              </Row>
            ) : null}
          </div>
        </div>
      )}

      <p className="tnd-note">
        {planWindowNote(window, taskName)}{' '}
        {window?.on_critical_path && window.award_by ? (
          <><span className="tnd-crit">◆ Critical path</span> — award by {fmtShort(window.award_by)} keeps the finish date.</>
        ) : null}
      </p>

      {!decided && canIssue && winner ? (
        confirming ? (
          <div className="tnd-confirm" role="group" aria-label="Confirm the award">
            <b>Award {winner.name}?</b>
            <span>{awardConsequences({ winnerName: winner.name, otherBids: Math.max(0, cols.length - 1), taskName })}</span>
            <div className="tnd-row">
              <button type="button" className="btn sm" onClick={() => setConfirming(false)}>Cancel</button>
              <button type="button" className="btn primary sm" disabled={busy} onClick={() => void award()}>
                {busy ? 'Awarding…' : 'Award it'}
              </button>
            </div>
          </div>
        ) : (
          <div className="tnd-row">
            <button type="button" className="btn primary sm" disabled={blocked !== null} onClick={() => setConfirming(true)}>
              Award {winner.name}
            </button>
            {blocked ? <span className="tnd-note">{blocked}</span> : null}
          </div>
        )
      ) : null}
      {decided ? (
        <p className="tnd-note">Awarded. Every proposal stays on the record, including the ones not chosen.</p>
      ) : null}
    </div>
  );
}

function Row({ label, last = false, children }: { label: string; last?: boolean; children: ReactNode }) {
  return (
    <>
      <span className={`l${last ? ' last' : ''}`} role="rowheader">{label}</span>
      {children}
    </>
  );
}
