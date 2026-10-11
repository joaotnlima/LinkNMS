'use client';

// PRD-12 N-5 — the next step on one question, as the server offered it: the
// addressee answers (a design change with approve / reject), the asker
// resolves once answered.
import { useRef, useState } from 'react';

import { answerQuestionAction, resolveQuestionAction } from '@/lib/v2/questions-actions';

export function QuestionActions({ projectId, questionId, actions, needsDecision }: {
  projectId: string; questionId: string; actions: Array<'answer' | 'resolve'>; needsDecision: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerId = useRef<string | null>(null);
  if (!actions.length) return null;

  async function answer(decision?: 'approved' | 'rejected') {
    if (!text.trim()) { setError(needsDecision ? 'Say why — the decision goes on the record with it.' : 'Write the answer.'); return; }
    if (!answerId.current) answerId.current = crypto.randomUUID();
    setBusy(true); setError(null);
    const res = await answerQuestionAction(projectId, questionId, { id: answerId.current, body: text, decision });
    setBusy(false);
    if (!res.ok) { setError(res.message); return; }
    answerId.current = null;
    setText('');
  }

  async function resolve() {
    setBusy(true); setError(null);
    const res = await resolveQuestionAction(projectId, questionId);
    setBusy(false);
    if (!res.ok) setError(res.message);
  }

  return (
    <div className="crd-act">
      {actions.includes('answer') ? (
        <>
          <textarea className="ste-field" rows={2} maxLength={8000} value={text}
            onChange={(e) => { answerId.current = null; setText(e.target.value); }}
            placeholder={needsDecision ? 'Your decision and why' : 'Your answer'} />
          {needsDecision ? (
            <>
              <button type="button" className="btn approve" disabled={busy} onClick={() => void answer('approved')}>Approve</button>
              <button type="button" className="btn reject" disabled={busy} onClick={() => void answer('rejected')}>Reject</button>
            </>
          ) : <button type="button" className="btn primary" disabled={busy} onClick={() => void answer()}>Answer</button>}
        </>
      ) : null}
      {actions.includes('resolve') ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void resolve()}>Resolve</button>
      ) : null}
      {error ? <p className="ste-error" role="alert">{error}</p> : null}
    </div>
  );
}
