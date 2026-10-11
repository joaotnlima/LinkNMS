'use client';

// Composer step 3 · Review & send (PRD-02 T-7, PRD-04 X-4, design C2). A
// summary of the scope and the bidders — each tagged by source, with its proof
// note — whether it is also an open request, the critical-path alert, and ONE
// confirmation that says what sending does: a personal link per bidder, the
// task's dates locked until the award, and the e-mail invitees' unclaimed
// directory profiles.

import { emailInviteeCount } from '@/lib/v2/rfp-directory-view';
import { sendConfirmation, sendLabel, type V2TenderWindow } from '@/lib/v2/tender-flow-view';
import type { V2Recipient } from '@/lib/v2/tendering-view';
import { BidderRow } from './DirectoryBits';
import { CriticalAlert } from './TenderBits';

export function ReviewStep({
  scopeLine, recipients, listed, taskName, window, sending, blocked, onSend, onBack,
}: {
  scopeLine: string;
  recipients: V2Recipient[];
  listed: boolean;
  taskName: string;
  window: V2TenderWindow | null;
  sending: boolean;
  blocked: string | null;
  onSend: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <span className="tnd-st-sum">{scopeLine}</span>
      {recipients.length > 0 ? (
        <div className="tnd-card">
          {recipients.map((r) => <BidderRow key={r.id} recipient={r} />)}
        </div>
      ) : null}
      {listed ? (
        <span className="tnd-note is-strong">
          Also listed as an open request: matching companies can ask to bid. Nobody gets a link until you approve them.
        </span>
      ) : null}
      <CriticalAlert window={window} taskName={taskName} phase="compose" />
      <div className="tnd-confirm" role="group" aria-label="Confirm sending the tender">
        <span>{sendConfirmation({ bidders: recipients.length, taskName, listed, emailInvitees: emailInviteeCount(recipients) })}</span>
        <div className="tnd-row">
          <button type="button" className="btn sm" onClick={onBack} disabled={sending}>Not yet</button>
          <button type="button" className="btn primary sm" disabled={sending || blocked !== null} onClick={onSend}>
            {sending ? 'Sending…' : sendLabel(recipients.length)}
          </button>
        </div>
        {blocked ? <span>{blocked}</span> : null}
      </div>
    </>
  );
}
