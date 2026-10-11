'use client';

// PRD-04 pieces shared by the composer and the follow view: a bidder row
// tagged by where it came from (Directory / Email / Asked to bid) with its
// note ("unclaimed profile", "not on LinkNMS yet"), the Verified/Stated proof
// tag, and the "Also list it as an open request" toggle (X-3).

import type { ReactNode } from 'react';

import { recipientName, recipientNote, sourceTag } from '@/lib/v2/rfp-directory-view';
import type { V2Recipient } from '@/lib/v2/tendering-view';

const toneClass = (tone: string) => (tone === 'quiet' ? '' : tone);

export function SourceTag({ source }: { source: V2Recipient['source'] }) {
  const tag = sourceTag(source);
  return <span className={`tnd-badge ${toneClass(tag.tone)}`}>{tag.label}</span>;
}

export function ProofTag({ tag }: { tag: 'Verified' | 'Stated' | string }) {
  return <span className={`tnd-badge ${tag === 'Verified' ? 'good' : ''}`} title={tag === 'Verified'
    ? 'On the record: clients verified by LinkNMS' : 'Stated by the company — not checked'}>{tag}</span>;
}

/** One bidder: name · note, its source tag, then whatever the caller adds (status, amount, actions). */
export function BidderRow({ recipient, children }: { recipient: V2Recipient; children?: ReactNode }) {
  const note = recipientNote(recipient);
  return (
    <div className="tnd-inv">
      <span className="e">
        {recipientName(recipient)}
        {note ? <span className="tnd-note"> · {note}</span> : null}
      </span>
      <SourceTag source={recipient.source} />
      {children}
    </div>
  );
}

export function ListedToggle({ listed, busy, onChange, specialtyName }: {
  listed: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
  /** "Roofing" — the task's specialty, when it has one. */
  specialtyName?: string | null;
}) {
  return (
    <label className="tnd-row" style={{ alignItems: 'flex-start', gap: 8 }}>
      <input type="checkbox" checked={listed} disabled={busy} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>Also list it as an open request</b>
        <span className="tnd-note" style={{ display: 'block' }}>
          {specialtyName ? `${specialtyName} companies` : 'Companies with this specialty'} in the directory whose area covers
          this build see it and can ask to bid. Nobody gets a link until you approve them.
        </span>
      </span>
    </label>
  );
}
