'use client';

// The issuer's side of clarifications (PRD-08 H-7/H-8): every question on the
// RFP, the open ones first, each with an answer box. An answer is published to
// ALL bidders (no private answers — PRD-08 §5) and the asker is never shown;
// the server enforces both, this only renders. Mounted by the RFP detail
// (/tendering/rfps/{id}) and the tender workspace's Clarifications section.

import { useCallback, useEffect, useState } from 'react';

import { answerClarificationAction, loadClarificationsAction } from '../procurement-actions';
import { clarificationMeta, issuerOrder, openCount } from '@/lib/v2/tendering-home-view';
import type { V2Clarification } from '@/lib/v2/tendering-view';
import './tender.css';

/** The issuer's side (H-7): every question, open first; an answer goes to every bidder. */
export function IssuerClarifications({ rfpId, canAnswer, onOpenCount }: {
  rfpId: string;
  canAnswer: boolean;
  onOpenCount?: (n: number) => void;
}) {
  const [items, setItems] = useState<V2Clarification[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await loadClarificationsAction(rfpId);
    const list = res?.items ?? [];
    setItems(list);
    onOpenCount?.(openCount(list));
  }, [rfpId, onOpenCount]);
  useEffect(() => { void reload(); }, [reload]);

  const answer = async (id: string) => {
    const text = (drafts[id] ?? '').trim();
    if (!text) { setError('Write the answer first.'); return; }
    setBusy(id); setError(null);
    const res = await answerClarificationAction(id, text);
    setBusy(null);
    if (!res.ok) { setError(res.message); return; }
    setDrafts((d) => ({ ...d, [id]: '' }));
    await reload();
  };

  if (items === null) return <p className="tnd-note" role="status">Loading questions…</p>;
  const ordered = issuerOrder(items);
  return (
    <section className="tnd" style={{ gap: 10 }} aria-label="Clarifications">
      <p className="tnd-note is-strong">
        Your answer goes to every bidder on this tender. Who asked is never shown to the others.
      </p>
      {error ? <p className="tnd-err" role="alert">{error}</p> : null}
      {ordered.length === 0 ? <p className="tnd-note">No questions from bidders yet.</p> : ordered.map((c) => (
        <article key={c.id} className={`tnd-q${c.status === 'open' ? ' is-open' : ''}`} aria-label="Question">
          <p className="tnd-q-text">{c.question}</p>
          {c.answer ? <p className="tnd-q-answer">{c.answer}</p> : null}
          <span className="tnd-note">{clarificationMeta(c, 'issuer')}</span>
          {c.status === 'open' && canAnswer ? (
            <div className="tnd-field">
              <textarea className="tnd-input" aria-label="Answer for every bidder" maxLength={8000}
                value={drafts[c.id] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))} />
              <div className="tnd-row">
                <button type="button" className="btn primary sm" disabled={busy === c.id || !(drafts[c.id] ?? '').trim()}
                  onClick={() => void answer(c.id)}>
                  {busy === c.id ? 'Publishing…' : 'Answer all bidders'}
                </button>
              </div>
            </div>
          ) : null}
        </article>
      ))}
    </section>
  );
}
