'use client';

// Out for bids · "Asking to bid" (PRD-04 X-5, design C3; D-47): companies that
// found the open request and asked. Each with its proof line (the directory's
// "on the record" counts, Verified / Stated), Approve — send link (the server
// creates the lane and mails the personal link) and Decline (the company is
// told), and its profile. Decided requests stay listed, quietly, for the record.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { approveBidRequestAction, declineBidRequestAction, loadBidRequestsAction } from '../rfp-directory-actions';
import { bidRequestBadge, pendingFirst, proofLine, type V2BidRequest } from '@/lib/v2/rfp-directory-view';
import { ProofTag } from './DirectoryBits';

export function AskingToBid({ rfpId, canDecide, onDecided }: {
  rfpId: string;
  canDecide: boolean;
  /** An approval adds a bidder: the caller re-reads its bidders. */
  onDecided: () => void;
}) {
  const [items, setItems] = useState<V2BidRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => setItems(await loadBidRequestsAction(rfpId)), [rfpId]);
  useEffect(() => { void reload(); }, [reload]);

  const decide = async (id: string, approve: boolean) => {
    setBusy(id); setError(null);
    const res = approve ? await approveBidRequestAction(id) : await declineBidRequestAction(id);
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    await reload();
    onDecided();
  };

  if (!items || items.length === 0) return null;
  const pending = items.filter((r) => r.status === 'pending').length;
  return (
    <section className="tnd" style={{ gap: 8 }} aria-label="Asking to bid">
      <div className="tnd-row is-split">
        <b className="tnd-h">Asking to bid ({pending})</b>
        <span className="tnd-note">from your open request</span>
      </div>
      {error ? <p className="tnd-err" role="alert">{error}</p> : null}
      <div className="tnd-card">
        {pendingFirst(items).map((r) => {
          const name = r.company?.display_name ?? 'A company';
          const proof = r.company ? proofLine(r.company) : null;
          const badge = bidRequestBadge(r.status);
          return (
            <div key={r.id} className="tnd-inv" style={{ flexWrap: 'wrap' }}>
              <span className="e">
                {name}
                {proof ? <span className="tnd-note"> · {proof.text}</span> : null}
              </span>
              {proof ? <ProofTag tag={proof.tag} /> : null}
              <span className={`tnd-badge ${badge.tone === 'quiet' ? '' : badge.tone}`}>{badge.label}</span>
              {canDecide && r.status === 'pending' ? (
                <>
                  <button type="button" className="btn primary sm" disabled={busy !== null} onClick={() => void decide(r.id, true)}>
                    {busy === r.id ? 'Working…' : 'Approve — send link'}
                  </button>
                  <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void decide(r.id, false)}>Decline</button>
                </>
              ) : null}
              {r.company?.slug ? <Link className="tnd-link" href={`/companies/${r.company.slug}`}>Profile</Link> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
