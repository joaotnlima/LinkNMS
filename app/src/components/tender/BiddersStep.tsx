'use client';

// Composer step 2 · Bidders (PRD-02 T-6, PRD-04 X-1..X-3). Each bidder is
// tagged by where it came from (Directory / Email) and shows `Queued` until the
// RFP is sent; it can be removed while it is a draft. Suggested companies from
// the directory slot in through `suggestions`, above the email box; the
// "Also list it as an open request" toggle through `listing`, below it.

import { useMemo, useState, type ReactNode } from 'react';

import { recipientName } from '@/lib/v2/rfp-directory-view';
import { parseRecipients, recipientStatusBadge, type V2Recipient } from '@/lib/v2/tendering-view';
import { BidderRow } from './DirectoryBits';

export function BiddersStep({
  recipients, onAdd, onRemove, busy, suggestions = null, listing = null, onContinue, continueBlocked,
}: {
  recipients: V2Recipient[];
  /** Resolves true when the addresses were saved. */
  onAdd: (emails: string[]) => Promise<boolean>;
  onRemove: (recipientId: string) => void;
  busy: boolean;
  /** PRD-04 "Suggested companies" (directory) — rendered above the email box. */
  suggestions?: ReactNode;
  /** PRD-04 X-3 "Also list it as an open request" — rendered below the email box. */
  listing?: ReactNode;
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
              <BidderRow key={r.id} recipient={r}>
                <span className={`tnd-badge ${badge.tone === 'quiet' ? '' : badge.tone}`}>{badge.label}</span>
                <button type="button" className="btn sm" disabled={busy}
                  aria-label={`Remove ${recipientName(r)}`} onClick={() => onRemove(r.id)}>✕</button>
              </BidderRow>
            );
          })}
        </div>
      ) : (
        <span className="tnd-note">Nobody yet. Nothing is sent until you review and send.</span>
      )}

      {suggestions}

      <div className="tnd-field">
        <label className="tnd-label" htmlFor="tnd-add">Someone not on LinkNMS? Add them by email</label>
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

      {listing}

      <div className="tnd-row">
        <button type="button" className="btn primary sm" disabled={continueBlocked !== null} onClick={onContinue}>
          Continue to review
        </button>
        {continueBlocked ? <span className="tnd-note">{continueBlocked}</span> : null}
      </div>
    </>
  );
}
