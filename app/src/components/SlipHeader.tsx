'use client';

// PRD-13 S-6 — the plan header's handover pill and the "Changes since baseline"
// door. The date, the net working days and the unseen count are the server's
// (Schedule.handover / Schedule.changes); this only words them.
import { handoverWords, type PlanSlipView } from '@/lib/v2/slip-view';
import './plan-slip.css';

export function SlipHeader({
  slip,
  onOpenChanges,
}: {
  slip: PlanSlipView | undefined;
  /** Opens the Changes panel; absent → the count shows without a door. */
  onOpenChanges?: () => void;
}) {
  const words = handoverWords(slip?.handover ?? null);
  if (!slip || !words) return null;
  const { total, unseen } = slip.changes;
  return (
    <div className="slp-head" role="group" aria-label="Project handover and changes since baseline">
      <span
        className={`slp-fin is-${words.tone}`}
        title={slip.handover?.baselineFinish
          ? `Baseline handover ${slip.handover.baselineFinish}; today’s overruns and the pushes they would make are included`
          : 'The latest finish in the plan, with today’s overruns'}
      >
        <span aria-hidden>◆</span> Handover {words.date}
        {slip.baselined && words.delta ? <strong> · {words.delta}</strong> : null}
      </span>
      {slip.baselined ? (
        <button
          type="button"
          className="slp-chg"
          onClick={onOpenChanges}
          disabled={!onOpenChanges}
          aria-label={`Changes since baseline: ${total}${unseen ? `, ${unseen} not seen by you` : ''}`}
        >
          Changes since baseline · {total}
          {unseen > 0 ? <span className="slp-new">{unseen} new</span> : null}
        </button>
      ) : null}
    </div>
  );
}
