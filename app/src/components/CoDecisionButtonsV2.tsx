'use client';

// Approve / reject (and, for the proposer, withdraw) a v2 change order (LINA-321,
// S4). This is the v2 twin of `CoDecisionButtons`: it calls the server action
// `decideChangeOrderV2` — NOT a fetch to an API route — so the write runs through
// the server-only v2 client and the two-sided rule stays server-enforced. The gate
// (`decideBlock` in `lib/v2/change-orders-view`) decides which buttons this even
// renders; a proposer never receives a decide button here, and a 403 that slips
// through a race comes back as the sentence the action built, shown in-place.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import type { DecideResult } from '@/app/change-orders/[id]/actions';

export interface CoDecisionButtonsV2Props {
  id: string;
  /** From `decideBlock`: may the viewer approve/reject (they are the deciding party)? */
  canDecide: boolean;
  /** When the viewer cannot decide, the reason to show (e.g. the two-sided rule). */
  cannotDecideMessage?: string;
  /** The proposer may retract an open CO (draft/submitted). */
  canWithdraw: boolean;
  onDecide: (id: string, action: 'approve' | 'reject' | 'withdraw', note?: string) => Promise<DecideResult>;
}

export function CoDecisionButtonsV2({
  id,
  canDecide,
  cannotDecideMessage,
  canWithdraw,
  onDecide,
}: CoDecisionButtonsV2Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: 'approve' | 'reject' | 'withdraw') {
    setError(null);
    startTransition(async () => {
      const res = await onDecide(id, action);
      if (res.ok) {
        router.refresh();
      } else {
        setError(res.message);
      }
    });
  }

  // Nothing to offer: not the deciding party and not the proposer. Surface WHY
  // (the two-sided rule) rather than a blank space.
  if (!canDecide && !canWithdraw) {
    return cannotDecideMessage ? (
      <p className="cap" style={{ marginTop: 4 }}>{cannotDecideMessage}</p>
    ) : null;
  }

  return (
    <div className="stack">
      <div className="btn-row">
        {canDecide && (
          <>
            <button className="btn approve" disabled={pending} onClick={() => run('approve')}>
              ✓ Approve — move the budget
            </button>
            <button className="btn reject" disabled={pending} onClick={() => run('reject')}>
              Reject
            </button>
          </>
        )}
        {canWithdraw && (
          <button className="btn" disabled={pending} onClick={() => run('withdraw')}>
            Withdraw
          </button>
        )}
      </div>
      {error && (
        <div className="integrity bad" role="alert">{error}</div>
      )}
    </div>
  );
}
