// The notification centre's data layer on `/api/v2` (PRD-12 N-1, N-2). I/O only:
// every read and write goes through the shared v2 client; the pure arranging
// lives in `./notifications-view.ts`.
//
// Reads fail closed: a viewer the mirror has not caught up with (or no session)
// gets an empty centre and a silent bell, never a crash in the shell — the bell
// renders on every portal page. Writes rethrow so the action can say why.
import 'server-only';

import { v2, V2Error } from './client';
import type {
  NotificationCategory, V2NotificationPage, V2NotificationPreference,
} from './notifications-view';

const EMPTY: V2NotificationPage = { items: [], next_cursor: null, unread_count: 0 };

/** The bell: `unread_count` off a one-item page. 0 on any refusal. */
export async function getUnreadCount(): Promise<number> {
  try {
    const page = await v2<V2NotificationPage>({ method: 'GET', path: '/me/notifications', query: { limit: 1 } });
    return page.unread_count ?? 0;
  } catch (err) {
    if (err instanceof V2Error) return 0;
    throw err;
  }
}

export async function listMyNotifications(opts: {
  unread?: boolean; category?: NotificationCategory; cursor?: string; limit?: number;
} = {}): Promise<V2NotificationPage> {
  try {
    return await v2<V2NotificationPage>({
      method: 'GET',
      path: '/me/notifications',
      query: {
        unread: opts.unread ? 'true' : undefined,
        category: opts.category,
        cursor: opts.cursor,
        limit: opts.limit ?? 50,
      },
    });
  } catch (err) {
    if (err instanceof V2Error) return EMPTY;
    throw err;
  }
}

export async function markNotificationsRead(input: { ids: string[] } | { all: true }): Promise<void> {
  await v2<null>({ method: 'POST', path: '/notifications:mark-read', body: input });
}

export async function getNotificationPreferences(): Promise<V2NotificationPreference[]> {
  try {
    const res = await v2<{ items: V2NotificationPreference[] }>({ method: 'GET', path: '/me/notification-preferences' });
    return res.items;
  } catch (err) {
    if (err instanceof V2Error) return [];
    throw err;
  }
}

export async function putNotificationPreferences(items: V2NotificationPreference[]): Promise<V2NotificationPreference[]> {
  const res = await v2<{ items: V2NotificationPreference[] }>({
    method: 'PUT', path: '/me/notification-preferences', body: { items },
  });
  return res.items;
}
