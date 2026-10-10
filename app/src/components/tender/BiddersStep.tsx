'use client';

// Composer step 2 · Bidders (PRD-02 T-6). Add by email (a pasted column works);
// each bidder shows `Queued` until the RFP is sent, and can be removed while it
// is a draft. Finding companies in the directory arrives with PRD-04: it slots
// in through `suggestions`, above the email box, without reshaping this step.

import { useMemo, useState, type ReactNode } from 'react';

import { parseRecipients, recipientStatusBadge, type V2Recipient } from '@/lib/v2/tendering-view';

export function BiddersStep({
  recipients, onAdd, onRemove, busy, suggestions = null, onContinue, continueBlocked,
}: {
  recipients: V2Recipient[];
  /** Resolves true when the addresses were saved. */
  onAdd: (emails: string[]) => Promise<boolean>;
  onRemove: (recipientId: string) => void;
  busy: boolean;
  /** PRD-04 "Suggested companies" (directory) — rendered above the email box. */
  suggestions?: ReactNode;
  onContinue: () => void;
  continueBlocked: string | null;
}) {
  const [draft, setDraft] = useState('');
  const [rejected, setRejected] = useState<{ invalid: string[]; duplicates: string[] } | null>(null);
  const emails = useMemo(() => recipients.map((r) => r.email), [recipients]);

  const add = async () => {
    const parsed = parseRecipients(draft, emails);
    setRejected(parsed.invalid.length || parsed.duplicates.length
      ? { invalid: parsed.invalid, duplicates: parsed.duplicates } : null);
    if (parsed.valid.length === 0) return;
    if (await onAdd(parsed.valid)) setDraft(parsed.invalid.join(', '));
  };

  return (
    <>
      {recipients.length > 0 ? (
        <div>
          {recipients.map((r) => {
            const badge = recipientStatusBadge(r.status);
            return (
              <div key={r.id} className="tnd-inv">
                <span className="e">{r.email}</span>
                <span className={`tnd-badge ${badge.tone === 'quiet' ? '' : badge.tone}`}>{badge.label}</span>
                <button type="button" className="btn sm" disabled={busy}
                  aria-label={`Remove ${r.email}`} onClick={() => onRemove(r.id)}>✕</button>
              </div>
            );
          })}
        </div>
      ) : (
        <span className="tnd-note">Nobody yet. Nothing is sent until you review and send.</span>
      )}

      {suggestions}

      <div className="tnd-field">
        <label className="tnd-label" htmlFor="tnd-add">Add contractors by email</label>
        <textarea
          id="tnd-add" className="tnd-input" value={draft} disabled={busy}
          placeholder="ana@obra.pt, joao@construcoes.pt — or paste a column from a spreadsheet"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void add(); }
          }}
        />
        <div className="tnd-row">
          <button type="button" className="btn sm" disabled={busy || !draft.trim()} onClick={() => void add()}>
            Add to list
          </button>
        </div>
        {rejected ? (
          <span className="tnd-err" role="status">
            {rejected.invalid.length ? `Not an email address: ${rejected.invalid.join(', ')}. ` : ''}
            {rejected.duplicates.length ? `Already on the list: ${rejected.duplicates.join(', ')}.` : ''}
          </span>
        ) : null}
      </div>

      <div className="tnd-row">
        <button type="button" className="btn primary sm" disabled={continueBlocked !== null} onClick={onContinue}>
          Continue to review
        </button>
        {continueBlocked ? <span className="tnd-note">{continueBlocked}</span> : null}
      </div>
    </>
  );
}
