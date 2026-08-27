// Change-order status as colour + label + icon (FR9). Reused by the list and the
// detail screen so the state reads identically everywhere.
import type { CoStatus } from '@/lib/types';
import { Check, StatusIcon } from './icons';

export function CoStatusChip({ status }: { status: CoStatus }) {
  if (status === 'approved') {
    return (
      <span className="badge ok">
        <Check className="ok-stroke" />
        Approved
      </span>
    );
  }
  if (status === 'rejected') {
    return (
      <span className="badge bad">
        <StatusIcon name="alert-octagon" />
        Rejected
      </span>
    );
  }
  return (
    <span className="badge warn">
      <StatusIcon name="alert-triangle" />
      Pending review
    </span>
  );
}
