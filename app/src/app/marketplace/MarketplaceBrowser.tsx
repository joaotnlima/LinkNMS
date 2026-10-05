'use client';

// The marketplace browser — the one client island on an otherwise server-rendered
// page (LINA-406). It renders the open listing the server read, lets a bidder
// narrow it by specialty, and claims a lane through the `applyAction` server
// action. It imports only pure view helpers and types — never the server-only
// I/O — so nothing here drags `server-only` into the client bundle.
//
// ── WHAT "APPLY" DOES ────────────────────────────────────────────────────────
// Apply claims this org's proposal lane on the RFP (idempotent server-side), then
// sends the bidder straight to the bid editor (`/marketplace/bid/[rfpId]`, Slice
// 3) to PRICE and SEND the figure. A card the org already holds a lane on shows
// an "Applied" badge and a link back into that editor, so the bid is always one
// click away — never a dead "the bid step opens here next" stub.
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { formatDateOnly } from '@/lib/v2/rfp-link-view';
import type { V2Rfp } from '@/lib/v2/tendering-view';

import { applyAction } from './actions';
import './marketplace.css';

export function MarketplaceBrowser({
  rfps,
  appliedRfpIds,
  activeSpecialty,
}: {
  rfps: V2Rfp[];
  appliedRfpIds: string[];
  activeSpecialty: string;
}) {
  const router = useRouter();
  // Lanes claimed in THIS session (optimistic), merged with the ids the server
  // already knew about, so a card stays "Applied" without a full reload.
  const [justApplied, setJustApplied] = useState<Set<string>>(new Set());
  const applied = new Set([...appliedRfpIds, ...justApplied]);

  // The specialty options come from the listing itself — the union of every
  // open RFP's specialties — so the filter only ever offers trades that exist.
  const specialties = [...new Set(rfps.flatMap((r) => r.specialties ?? []))].sort();

  const onFilter = (value: string) => {
    const params = new URLSearchParams();
    if (value) params.set('specialty', value);
    router.push(params.toString() ? `/marketplace?${params}` : '/marketplace');
  };

  return (
    <div className="mkt">
      <header className="mkt-head">
        <h1>Marketplace</h1>
        <p className="mkt-sub">
          Open requests looking for a company. Apply to one to register your
          interest and claim your proposal lane.
        </p>
      </header>

      {specialties.length > 0 ? (
        <div className="mkt-filter" role="group" aria-label="Filter by specialty">
          <button
            type="button"
            className={`mkt-chip${activeSpecialty ? '' : ' is-on'}`}
            onClick={() => onFilter('')}
          >
            All trades
          </button>
          {specialties.map((s) => (
            <button
              key={s}
              type="button"
              className={`mkt-chip${activeSpecialty === s ? ' is-on' : ''}`}
              onClick={() => onFilter(s)}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {rfps.length === 0 ? (
        <EmptyState specialty={activeSpecialty} onClear={() => onFilter('')} />
      ) : (
        <ul className="mkt-list">
          {rfps.map((rfp) => (
            <li key={rfp.id}>
              <RfpCard
                rfp={rfp}
                applied={applied.has(rfp.id)}
                onApplied={(id) => setJustApplied((prev) => new Set(prev).add(id))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RfpCard({
  rfp,
  applied,
  onApplied,
}: {
  rfp: V2Rfp;
  applied: boolean;
  onApplied: (rfpId: string) => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const apply = () => {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const res = await applyAction(rfp.id);
      if (res.ok) {
        onApplied(rfp.id);
        // Straight into pricing — the lane is claimed, the bid is the next step.
        router.push(`/marketplace/bid/${rfp.id}`);
      } else setError(res.error);
    });
  };

  return (
    <article className="mkt-card">
      <div className="mkt-card-main">
        <h2 className="mkt-card-title">{rfp.title}</h2>
        {rfp.scope_text ? <p className="mkt-card-scope">{rfp.scope_text}</p> : null}

        {rfp.specialties?.length ? (
          <div className="mkt-chips">
            {rfp.specialties.map((s) => (
              <span className="badge neutral" key={s}>
                {s}
              </span>
            ))}
          </div>
        ) : null}

        {rfp.submission_deadline ? (
          <p className="mkt-deadline">
            Proposals due by {formatDateOnly(rfp.submission_deadline.slice(0, 10))}.
          </p>
        ) : null}
      </div>

      <div className="mkt-card-side">
        {applied ? (
          <>
            <span className="badge ok">Applied</span>
            <Link className="btn primary" href={`/marketplace/bid/${rfp.id}`}>
              Price &amp; send your bid
            </Link>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn primary"
              onClick={apply}
              disabled={pending}
            >
              {pending ? 'Applying…' : 'Apply'}
            </button>
            {error ? (
              <p className="mkt-error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

function EmptyState({
  specialty,
  onClear,
}: {
  specialty: string;
  onClear: () => void;
}) {
  if (specialty) {
    return (
      <div className="mkt-empty">
        <p>No open requests for “{specialty}” right now.</p>
        <button type="button" className="btn" onClick={onClear}>
          Show all trades
        </button>
      </div>
    );
  }
  return (
    <div className="mkt-empty">
      <p>No open requests are looking for a company right now.</p>
      <p className="mkt-note">
        Open requests appear here the moment a homeowner or contractor opens one
        to the marketplace.
      </p>
    </div>
  );
}
