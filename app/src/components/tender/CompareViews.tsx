'use client';

// The Compare drill-down's renderers and the bid card they share (moved out of
// ProcurementSection, LINA-411/420 behaviour unchanged): the money-gated price
// MATRIX with its median column and programme bars (detailed tenders) and the
// DOCS renderer (light tenders: references, notes, portfolio side by side).
// The full workspace mounts these; the docked panel's side-by-side compare
// (PRD-02 T-14) is a separate, no-averages view (SideBySide.tsx).

import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { loadCompareAction } from '../procurement-actions';
import {
  compareRenderer, formatMoney, isLive, leadTimeWeeks, proposalDocumentDownloadPath, proposalStatusBadge,
  type CompareRenderer, type V2Comparison, type V2ProposalLane, type V2Rfp,
} from '@/lib/v2/tendering-view';
import type { CompareEntry, Inbox } from '@/lib/v2/tendering';
import '../procurement.css';

// ── Compare drill-down (a SURFACE, not a modal; LINA-411) ─────────────────────
// Reached only after shortlisting, over the shortlisted bids (or whatever the
// shared `?compare=` link named). Two renderers, keyed off the RFP's shape
// (D-39): a DETAILED tender tabulates per-line prices in the Matrix; a LIGHT
// tender — a design service, a fee not a BoQ — sets the bidders' references,
// notes and portfolio PDFs side by side as Docs. Back returns to the cards.

export function CompareSurface({
  rfp, inbox, comparedLanes, seesMoney, decided, picked, onPick, onBack, award,
}: {
  rfp: V2Rfp;
  inbox: Inbox | null;
  comparedLanes: V2ProposalLane[];
  seesMoney: boolean;
  decided: boolean;
  picked: string | null;
  onPick: (proposalId: string) => void;
  onBack: () => void;
  award: ReactNode;
}) {
  // The renderer defaults by content (LINA-420): a light/design RFP compares as
  // Documents, a detailed/execution RFP as the price Matrix. The owner can always
  // override with the toggle — e.g. to read the attached PDFs of an execution bid
  // side by side, or scan a design bid's (rare) priced lines. Null = follow auto.
  const [override, setOverride] = useState<CompareRenderer | null>(null);
  const renderer: CompareRenderer = override ?? compareRenderer(rfp);

  return (
    <section className="prc-compare" aria-label="Compare shortlisted proposals">
      <div className="prc-composer-hd">
        <button type="button" className="btn" onClick={onBack}>← Back to proposals</button>
        <h4 className="prc-subh">
          Comparing {comparedLanes.length} {comparedLanes.length === 1 ? 'bid' : 'bids'}
          {renderer === 'docs' ? ' — references & portfolio' : ' — priced line by line'}
        </h4>
        <div className="prc-seg prc-compare-toggle" role="radiogroup" aria-label="Compare view">
          <button
            type="button" role="radio" aria-checked={renderer === 'matrix'}
            className={`prc-seg-opt${renderer === 'matrix' ? ' is-on' : ''}`}
            onClick={() => setOverride('matrix')}
          >Matrix</button>
          <button
            type="button" role="radio" aria-checked={renderer === 'docs'}
            className={`prc-seg-opt${renderer === 'docs' ? ' is-on' : ''}`}
            onClick={() => setOverride('docs')}
          >Docs</button>
        </div>
      </div>

      {comparedLanes.length === 0 ? (
        <p className="prc-quiet">None of the shortlisted bids are available to compare any more.</p>
      ) : renderer === 'docs' ? (
        <DocsCompare
          comparedLanes={comparedLanes}
          seesMoney={seesMoney}
          decided={decided}
          picked={picked}
          onPick={onPick}
        />
      ) : (
        <MatrixCompare
          comparison={inbox?.comparison ?? null}
          comparedLanes={comparedLanes}
          seesMoney={seesMoney}
          decided={decided}
          picked={picked}
          onPick={onPick}
        />
      )}

      {award}
    </section>
  );
}

// ── Matrix renderer (detailed tender): the money-gated per-line price grid ─────

function MatrixCompare({
  comparison, comparedLanes, seesMoney, decided, picked, onPick,
}: {
  comparison: V2Comparison | null;
  comparedLanes: V2ProposalLane[];
  seesMoney: boolean;
  decided: boolean;
  picked: string | null;
  onPick: (proposalId: string) => void;
}) {
  return (
    <>
      <ul className="prc-proposals">
        {comparedLanes.map((lane) => (
          <LaneCard
            key={lane.proposal_id}
            lane={lane}
            seesMoney={seesMoney}
            picked={picked === lane.proposal_id}
            decided={decided}
            busy={false}
            onPick={() => onPick(lane.proposal_id)}
            onShortlist={() => { /* already shortlisted; not offered in the drill-down */ }}
            hideShortlist
          />
        ))}
      </ul>
      {!seesMoney ? (
        <p className="prc-quiet">
          The priced matrix needs the money permission on this organisation. You can still see who
          was shortlisted and award the best fit.
        </p>
      ) : comparison ? (
        <ComparisonMatrix comparison={comparison} lanes={comparedLanes} />
      ) : (
        <p className="prc-quiet">No priced lines to compare yet.</p>
      )}
    </>
  );
}

// ── Docs renderer (light tender): references, notes and portfolio side by side ─

function DocsCompare({
  comparedLanes, seesMoney, decided, picked, onPick,
}: {
  comparedLanes: V2ProposalLane[];
  seesMoney: boolean;
  decided: boolean;
  picked: string | null;
  onPick: (proposalId: string) => void;
}) {
  const [entries, setEntries] = useState<Record<string, CompareEntry> | null>(null);
  const ids = useMemo(() => comparedLanes.map((l) => l.proposal_id), [comparedLanes]);

  useEffect(() => {
    let live = true;
    setEntries(null);
    void loadCompareAction(ids).then((list) => {
      if (!live) return;
      setEntries(Object.fromEntries(list.map((e) => [e.detail.proposal_id, e])));
    });
    return () => { live = false; };
  }, [ids]);

  return (
    <div className="prc-docs" role="group" aria-label="Bidder references side by side">
      {comparedLanes.map((lane) => (
        <DocsColumn
          key={lane.proposal_id}
          lane={lane}
          entry={entries?.[lane.proposal_id] ?? null}
          loading={entries === null}
          seesMoney={seesMoney}
          picked={picked === lane.proposal_id}
          decided={decided}
          onPick={() => onPick(lane.proposal_id)}
        />
      ))}
    </div>
  );
}

function DocsColumn({
  lane, entry, loading, seesMoney, picked, decided, onPick,
}: {
  lane: V2ProposalLane;
  entry: CompareEntry | null;
  loading: boolean;
  seesMoney: boolean;
  picked: boolean;
  decided: boolean;
  onPick: () => void;
}) {
  const badge = proposalStatusBadge(lane.status);
  const name = lane.bidder.name ?? lane.bidder.email;
  const detail = entry?.detail ?? null;
  return (
    <article className={`prc-doc-col${picked ? ' is-selected' : ''}`}>
      <header className="prc-doc-col-hd">
        <span className="prc-company">{name}</span>
        <span className={`prc-badge ${badge.tone}`}>{badge.label}</span>
      </header>

      <dl className="prc-meta">
        <div><dt>Fee</dt><dd>{seesMoney ? formatMoney(detail?.total) : '—'}</dd></div>
        {detail?.duration_wd != null ? (
          <div><dt>Lead time</dt><dd>{detail.duration_wd} working days</dd></div>
        ) : null}
        {detail?.validity_until ? (
          <div><dt>Valid until</dt><dd>{formatWhen(detail.validity_until)}</dd></div>
        ) : null}
      </dl>

      {loading ? (
        <p className="prc-quiet" role="status">Loading…</p>
      ) : (
        <>
          <div className="prc-doc-sec">
            <span className="prc-label">References</span>
            {detail?.reference_notes ? (
              <p className="prc-comment">{detail.reference_notes}</p>
            ) : (
              <p className="prc-quiet">No references given.</p>
            )}
          </div>

          {detail?.conditions ? (
            <div className="prc-doc-sec">
              <span className="prc-label">Conditions</span>
              <p className="prc-comment">{detail.conditions}</p>
            </div>
          ) : null}

          <div className="prc-doc-sec">
            <span className="prc-label">Portfolio</span>
            {entry && entry.documents.length > 0 ? (
              <ul className="prc-doc-list">
                {entry.documents.map((doc) => (
                  <li key={doc.id} className="prc-doc">
                    <a
                      className="prc-doc-name"
                      href={proposalDocumentDownloadPath(lane.proposal_id, doc.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {doc.title}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="prc-quiet">No files attached.</p>
            )}
          </div>
        </>
      )}

      {!decided && isLive(lane) ? (
        <div className="prc-actions">
          <button type="button" className={`btn${picked ? ' primary' : ''}`} onClick={onPick}>
            {picked ? 'Picked' : 'Pick to award'}
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function LaneCard({
  lane, seesMoney, picked, decided, busy, onPick, onShortlist, hideShortlist = false,
}: {
  lane: V2ProposalLane;
  seesMoney: boolean;
  picked: boolean;
  decided: boolean;
  busy: boolean;
  onPick: () => void;
  onShortlist: () => void;
  /** In the Compare drill-down the bids are already shortlisted; don't re-offer it. */
  hideShortlist?: boolean;
}) {
  const badge = proposalStatusBadge(lane.status);
  const name = lane.bidder.name ?? lane.bidder.email;
  return (
    <li className={`prc-proposal${picked ? ' is-selected' : ''}`}>
      <div className="prc-proposal-hd">
        <span className="prc-company">{name}</span>
        <span className={`prc-badge ${badge.tone}`}>{badge.label}</span>
        {/* price · lead time · portfolio — the three a card is read on */}
        {seesMoney ? <span className="prc-figure">{formatMoney(lane.total)}</span> : null}
        {lane.duration_wd != null ? (
          <span className="prc-figure quiet" title={`${lane.duration_wd} working days`}>
            {leadTimeWeeks(lane.duration_wd)}
          </span>
        ) : null}
        {lane.document_count > 0 ? (
          <span className="prc-figure quiet">
            {lane.document_count} {lane.document_count === 1 ? 'file' : 'files'}
          </span>
        ) : null}
        {lane.channel === 'email' ? <span className="prc-badge quiet">By email</span> : null}
        {lane.missing_lines > 0 ? (
          <span className="prc-badge warn">{lane.missing_lines} lines unpriced</span>
        ) : null}
        {!decided && isLive(lane) ? (
          <>
            {!hideShortlist && lane.status === 'submitted' ? (
              <button type="button" className="btn" disabled={busy} onClick={onShortlist}>
                {busy ? '…' : 'Shortlist'}
              </button>
            ) : null}
            <button type="button" className={`btn${picked ? ' primary' : ''}`} onClick={onPick}>
              {picked ? 'Picked' : 'Pick to award'}
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}

// ── Comparison matrix (money-gated) ──────────────────────────────────────────

function ComparisonMatrix({
  comparison, lanes,
}: {
  comparison: V2Comparison;
  lanes: V2ProposalLane[];
}) {
  const byId = new Map(lanes.map((l) => [l.proposal_id, l]));
  // Columns are the bids the server actually compares (submitted/shortlisted/
  // awarded), in the ordered-lane order so the matrix reads like the list above.
  // A declined or withdrawn lane still shows as a card but is not a column here —
  // there is no live price to compare.
  const compared = new Set(comparison.proposals.map((p) => p.proposal_id));
  const cols = lanes.map((l) => l.proposal_id).filter((id) => byId.has(id) && compared.has(id));

  if (comparison.items.length === 0 || cols.length === 0) return null;

  return (
    <div className="prc-matrix-wrap">
      <table className="prc-matrix">
        <thead>
          <tr>
            <th>Line</th>
            {cols.map((id) => (
              <th key={id}>{byId.get(id)?.bidder.name ?? byId.get(id)?.bidder.email ?? id}</th>
            ))}
            <th className="prc-median">Median</th>
          </tr>
        </thead>
        <tbody>
          {comparison.items.map((item) => (
            <tr key={item.rfp_item_id}>
              <td>{item.description} <span className="prc-median">({item.quantity} {item.unit})</span></td>
              {cols.map((id) => {
                const price = item.prices[id];
                const missing = item.missing_in.includes(id);
                return (
                  <td key={id} className={missing ? 'prc-missing' : undefined}>
                    {missing ? '— not priced' : formatMoney(price)}
                  </td>
                );
              })}
              <td className="prc-median">{formatMoney(item.median)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ProgrammeBars comparison={comparison} byId={byId} cols={cols} />
    </div>
  );
}

/**
 * The PROGRAMME section of the compare matrix (LINA-420, screen 8): each bidder's
 * weeks-on-site as a proportional bar, read off `comparison.durations` (already on
 * the wire; weeks via the same 5-wd week the cards speak). The shortest is tagged
 * "fastest" — the one call this section exists to make. Nothing renders when no
 * bidder gave a duration; it never invents a programme it wasn't told.
 */
function ProgrammeBars({
  comparison, byId, cols,
}: {
  comparison: V2Comparison;
  byId: Map<string, V2ProposalLane>;
  cols: string[];
}) {
  // Per proposal: total working days summed over every packaged task it priced.
  const totals = new Map<string, number>();
  for (const id of cols) {
    let wd = 0;
    let any = false;
    for (const d of comparison.durations) {
      const v = d.by_proposal[id];
      if (v != null && Number.isFinite(v)) { wd += v; any = true; }
    }
    if (any) totals.set(id, wd);
  }
  if (totals.size === 0) return null;

  const values = [...totals.values()];
  const max = Math.max(...values);
  const min = Math.min(...values);

  return (
    <div className="prc-programme">
      <div className="prc-programme-hd">
        Programme <span className="prc-median">weeks on site</span>
      </div>
      <ul className="prc-programme-rows">
        {cols.filter((id) => totals.has(id)).map((id) => {
          const wd = totals.get(id)!;
          const pct = max > 0 ? Math.max(6, Math.round((wd / max) * 100)) : 0;
          const fastest = wd === min && values.length > 1;
          const name = byId.get(id)?.bidder.name ?? byId.get(id)?.bidder.email ?? id;
          return (
            <li key={id} className={`prc-programme-row${fastest ? ' is-fastest' : ''}`}>
              <span className="prc-programme-name">{name}</span>
              <span className="prc-programme-track" aria-hidden>
                <span className="prc-programme-fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="prc-programme-wks">
                {leadTimeWeeks(wd)}
                {fastest ? <span className="prc-badge good">fastest</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** An ISO instant as a short human date-time, or an em dash when absent. */
function formatWhen(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
