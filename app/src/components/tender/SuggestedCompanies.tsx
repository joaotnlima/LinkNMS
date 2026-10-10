'use client';

// Composer step 2 · "Suggested companies" (PRD-04 X-1, design D3): companies
// matched on the task's specialty and the build's location — the directory's
// own search and ranking (D-46) — each with its proof line and ＋ Add / ✓ Added.
// "Search the directory →" opens the full search (D1) prefilled from the task;
// adding there returns to this panel. Adding puts the company on the DRAFT as a
// queued bidder with source "Directory" — nothing is sent from here.

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { addCompanyAction, loadSuggestionsAction } from '../rfp-directory-actions';
import type { V2DirectoryCard } from '@/lib/v2/directory-view';
import { directoryHref, isSuggestionAdded, suggestionLine } from '@/lib/v2/rfp-directory-view';
import type { V2Recipient } from '@/lib/v2/tendering-view';
import { ProofTag } from './DirectoryBits';

export function SuggestedCompanies({
  projectId, taskId, rfpId, specialtyCode, specialtyName, recipients, onAdded,
}: {
  projectId: string;
  taskId: string;
  rfpId: string;
  specialtyCode: string | null;
  specialtyName?: string | null;
  recipients: V2Recipient[];
  onAdded: (added: V2Recipient[]) => void;
}) {
  const [cards, setCards] = useState<V2DirectoryCard[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!specialtyCode) { setCards([]); return; }
    void loadSuggestionsAction(projectId, specialtyCode).then((c) => { if (live) setCards(c); });
    return () => { live = false; };
  }, [projectId, specialtyCode]);

  const add = async (card: V2DirectoryCard) => {
    setBusy(card.org_id); setError(null);
    const res = await addCompanyAction(rfpId, card.org_id);
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    onAdded(res.data);
  };

  const what = specialtyName ?? 'Companies';
  return (
    <section className="tnd-sub" aria-label="Suggested companies">
      <div className="tnd-row is-split">
        <b className="tnd-h">{specialtyCode ? `${what} companies near this build` : 'Find companies'}</b>
        <Link className="tnd-link" href={directoryHref({ projectId, taskId, rfpId, specialtyCode })}>Search the directory →</Link>
      </div>
      {specialtyCode ? (
        <span className="tnd-note">Matched on this task&apos;s specialty and the build&apos;s location. Companies with verified clients first.</span>
      ) : (
        <span className="tnd-note">Give this task a specialty on the Plan tab to see suggested companies here.</span>
      )}
      {error ? <span className="tnd-err" role="alert">{error}</span> : null}
      {cards === null ? <span className="tnd-note">Looking in the directory…</span> : null}
      {cards && specialtyCode && cards.length === 0 ? <span className="tnd-note">No company in the directory matches yet.</span> : null}
      {cards?.map((card) => {
        const added = isSuggestionAdded(card, recipients);
        const line = suggestionLine(card);
        return (
          <div key={card.org_id} className="tnd-inv">
            <span className="e">
              <Link className="tnd-link" href={`/companies/${card.slug}`}>{card.display_name}</Link>
              <span className="tnd-note"> · {line.text}</span>
            </span>
            <ProofTag tag={line.tag} />
            {added ? (
              <span className="tnd-badge good">✓ Added</span>
            ) : (
              <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void add(card)}>
                {busy === card.org_id ? 'Adding…' : '＋ Add'}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
