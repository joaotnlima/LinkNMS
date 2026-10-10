'use client';

// Composer step 3 · Review & send (PRD-02 T-7). A summary of the scope and the
// bidders, the critical-path alert, and ONE confirmation that says what sending
// does: a personal link per bidder, the task's dates locked until the award.

import type { V2Recipient, RfpVisibility } from '@/lib/v2/tendering-view';
import { sendConfirmation, sendLabel, type V2TenderWindow } from '@/lib/v2/tender-flow-view';
import { CriticalAlert } from './TenderBits';

export function ReviewStep({
  scopeLine, recipients, visibility, taskName, window, sending, blocked, onSend, onBack,
}: {
  scopeLine: string;
  recipients: V2Recipient[];
  visibility: RfpVisibility;
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
          {recipients.map((r) => (
            <div key={r.id} className="tnd-inv">
              <span className="e">{r.email}</span>
              <span className="tnd-badge">Email</span>
            </div>
          ))}
        </div>
      ) : null}
      <CriticalAlert window={window} taskName={taskName} phase="compose" />
      <div className="tnd-confirm" role="group" aria-label="Confirm sending the tender">
        <span>{sendConfirmation({ bidders: recipients.length, taskName, visibility })}</span>
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
