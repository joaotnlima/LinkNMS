// The v2 change-order status chip (LINA-321, S4). v2 has a FIVE-state lifecycle
// (contracting/domain/money.mjs CO_TRANSITIONS) — draft, submitted, approved,
// rejected, withdrawn — and this renders each honestly rather than round-tripping
// through the legacy three-state `CoStatusChip` (which collapses draft→submitted
// into "pending" and has no cell for withdrawn). LINA-358 ruling 3: render the v2
// status directly, not the lossy chip.
import { Check, StatusIcon } from './icons';
import type { V2CoStatus } from '@/lib/v2/change-orders-view';

export function CoStatusChipV2({ status }: { status: V2CoStatus }) {
  switch (status) {
    case 'approved':
      return (
        <span className="badge ok">
          <Check className="ok-stroke" />
          Approved
        </span>
      );
    case 'rejected':
      return (
        <span className="badge bad">
          <StatusIcon name="alert-octagon" />
          Rejected
        </span>
      );
    case 'submitted':
      return (
        <span className="badge warn">
          <StatusIcon name="alert-triangle" />
          Awaiting decision
        </span>
      );
    case 'withdrawn':
      return (
        <span className="badge">
          <StatusIcon name="alert-octagon" />
          Withdrawn
        </span>
      );
    case 'draft':
    default:
      return (
        <span className="badge">
          <StatusIcon name="info" />
          Draft
        </span>
      );
  }
}
