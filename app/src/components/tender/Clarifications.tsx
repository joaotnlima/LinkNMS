'use client';

// Clarifications (PRD-08 H-6..H-9) — one set of pieces for both sides:
//   ClarificationList     — questions and answers as a reader sees them;
//   BidderClarifications  — the list + the ask box, for the public link page
//                           and the in-app bid view (the ask is a server action
//                           the page binds to its token or RFP);
//   (IssuerClarifications.tsx — the issuer's side, kept apart so the public
//   link page never bundles the issuer's server actions.)
// The server decides everything that matters — who sees which question, whether
// asking is still open, that the asker is never named — this file only renders.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { askState, clarificationMeta, questionProblem } from '@/lib/v2/tendering-home-view';
import type { V2Clarification } from '@/lib/v2/tendering-view';
import './tender.css';

export type AskOutcome = { ok: true } | { ok: false; message: string };

export function ClarificationList({ items, role, empty }: {
  items: V2Clarification[];
  role: 'issuer' | 'bidder';
  empty: string;
}) {
  if (items.length === 0) return <p className="tnd-note">{empty}</p>;
  return (
    <div className="tnd" style={{ gap: 8 }}>
      {items.map((c) => (
        <article key={c.id} className={`tnd-q${c.status === 'open' ? ' is-open' : ''}`} aria-label="Question">
          <p className="tnd-q-text">{c.question}</p>
          {c.answer ? <p className="tnd-q-answer">{c.answer}</p> : null}
          <span className="tnd-note">{clarificationMeta(c, role)}</span>
        </article>
      ))}
    </div>
  );
}

/** The bidder's view: published answers, its own open questions, and the ask box (H-6, H-9). */
export function BidderClarifications({ items, questionsOpen, questionsDeadline, rfpStatus, ask }: {
  items: V2Clarification[];
  questionsOpen: boolean;
  questionsDeadline?: string | null;
  rfpStatus?: string;
  /** Server action bound to the token or the RFP by the page. */
  ask: (question: string) => Promise<AskOutcome>;
}) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const state = askState(questionsOpen, { questions_deadline: questionsDeadline, status: rfpStatus });

  const submit = async () => {
    const problem = questionProblem(text);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null); setSent(false);
    const res = await ask(text.trim());
    setBusy(false);
    if (!res.ok) { setError(res.message); return; }
    setText(''); setSent(true);
    router.refresh();
  };

  return (
    <section className="tnd" style={{ gap: 10 }} aria-label="Questions and answers">
      <b className="tnd-h">Questions and answers</b>
      <ClarificationList items={items} role="bidder"
        empty="No answers published yet. Answers to any bidder's question appear here for everyone." />
      {state.canAsk ? (
        <div className="tnd-field">
          <label className="tnd-label" htmlFor="tnd-ask">Ask the issuer</label>
          <textarea id="tnd-ask" className="tnd-input" value={text} maxLength={4000}
            onChange={(e) => setText(e.target.value)} placeholder="e.g. Does item 4.1 include the thermal insulation?" />
          <div className="tnd-row">
            <button type="button" className="btn primary sm" disabled={busy || !text.trim()} onClick={() => void submit()}>
              {busy ? 'Sending…' : 'Send question'}
            </button>
            {sent ? <span className="tnd-note" role="status">Sent. The answer will appear here for every bidder.</span> : null}
          </div>
        </div>
      ) : null}
      {error ? <p className="tnd-err" role="alert">{error}</p> : null}
      <p className="tnd-note">{state.note}</p>
    </section>
  );
}
