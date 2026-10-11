// NotificationBell — the shell's way into the notification centre (PRD-12 N-1).
// An async SERVER component: it reads the unread count (`unread_count` off a
// one-item page) and renders a plain link to /notifications with a badge. No
// client JS, no polling — every navigation re-renders the shell and so the
// count; a fail-closed read (no mirror, no session) just shows a quiet bell.
import Link from 'next/link';

import { getUnreadCount } from '@/lib/v2/notifications';
import { badgeText } from '@/lib/v2/notifications-view';

export async function NotificationBell() {
  const unread = await getUnreadCount();
  const badge = badgeText(unread);
  return (
    <Link
      className="psh-bell"
      href="/notifications"
      aria-label={badge ? `Notifications — ${unread} unread` : 'Notifications'}
    >
      <svg viewBox="0 0 24 24" role="presentation">
        <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </svg>
      {badge ? <span className="psh-bell-badge" aria-hidden="true">{badge}</span> : null}
    </Link>
  );
}
