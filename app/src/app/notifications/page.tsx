// /notifications — the notification centre (PRD-12 N-1, N-2; to-be/20).
//
// Everything that is waiting for the viewer, newest first, grouped by day: bids
// in, clarifications answered, awards, plan-change digests, invitations
// accepted, questions and quality items. Each row opens its deep link (the
// server's `object_ref.url`) and is marked read on the way; "Mark all read"
// clears the bell. Filters are links (`?unread=1`, `?category=`), so a filtered
// view is an address you can share. E-mail per type is set in /settings.
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PortalShell, type PortalUser } from '@/components/PortalShell';
import { getViewerProfile } from '@/lib/v2/profile';
import { listMyNotifications } from '@/lib/v2/notifications';
import {
  CATEGORY_LABEL, groupNotifications, type NotificationCategory,
} from '@/lib/v2/notifications-view';
import { sessionState } from '@/server/session';

import { markAllReadAction, markReadAction, openNotificationAction } from './actions';
import './notifications.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Notifications · LinkNMS' };

const CATEGORIES = Object.keys(CATEGORY_LABEL) as NotificationCategory[];

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ unread?: string; category?: string; cursor?: string }>;
}) {
  const state = await sessionState();
  if (state.kind === 'anonymous') redirect('/sign-in?next=/notifications');
  if (state.kind === 'unseated') redirect('/no-access');

  const sp = await searchParams;
  const unreadOnly = sp.unread === '1';
  const category = CATEGORIES.includes(sp.category as NotificationCategory)
    ? (sp.category as NotificationCategory)
    : undefined;

  const [profile, page] = await Promise.all([
    getViewerProfile(),
    listMyNotifications({ unread: unreadOnly, category, cursor: sp.cursor }),
  ]);
  const user: PortalUser = profile ?? { displayName: 'Your account', roleLabel: '' };
  const groups = groupNotifications(page.items);

  const href = (over: { unread?: boolean; category?: string | null }) => {
    const u = over.unread ?? unreadOnly;
    const c = over.category === undefined ? category : over.category;
    const q = new URLSearchParams();
    if (u) q.set('unread', '1');
    if (c) q.set('category', c);
    const s = q.toString();
    return s ? `/notifications?${s}` : '/notifications';
  };

  return (
    <PortalShell user={user} switcherLabel="Notifications" align="start">
      <section className="ntf">
        <header className="ntf-head">
          <div>
            <h1 className="ntf-title">Notifications</h1>
            <p className="ntf-sub">
              {page.unread_count > 0 ? `${page.unread_count} unread` : 'You are up to date'}
              {' · '}
              <Link href="/settings#notifications">E-mail preferences</Link>
            </p>
          </div>
          {page.unread_count > 0 ? (
            <form action={markAllReadAction}>
              <button type="submit" className="ntf-btn">Mark all read</button>
            </form>
          ) : null}
        </header>

        <nav className="ntf-filters" aria-label="Filter notifications">
          <Link className={`ntf-chip${!unreadOnly ? ' is-on' : ''}`} href={href({ unread: false })}>All</Link>
          <Link className={`ntf-chip${unreadOnly ? ' is-on' : ''}`} href={href({ unread: true })}>Unread</Link>
          <span className="ntf-sep" aria-hidden="true" />
          <Link className={`ntf-chip${!category ? ' is-on' : ''}`} href={href({ category: null })}>Every type</Link>
          {CATEGORIES.map((c) => (
            <Link key={c} className={`ntf-chip${category === c ? ' is-on' : ''}`} href={href({ category: c })}>
              {CATEGORY_LABEL[c].label}
            </Link>
          ))}
        </nav>

        {groups.length === 0 ? (
          <p className="ntf-empty">
            {unreadOnly || category ? 'Nothing here with these filters.' : 'Nothing has happened yet that needs you.'}
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="ntf-group" aria-labelledby={`ntf-${g.key}`}>
              <h2 id={`ntf-${g.key}`} className="ntf-group-title">{g.label}</h2>
              <ul className="ntf-list">
                {g.items.map((n) => (
                  <li key={n.id} className={`ntf-item${n.unread ? ' is-unread' : ''}`}>
                    <form action={openNotificationAction} className="ntf-open">
                      <input type="hidden" name="id" value={n.id} />
                      <input type="hidden" name="url" value={n.url} />
                      <button type="submit" className="ntf-open-btn">
                        <span className="ntf-cat">{n.categoryLabel}</span>
                        <span className="ntf-item-title">{n.title}</span>
                        <time className="ntf-time" dateTime={n.at}>
                          {new Date(n.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Lisbon' })}
                        </time>
                      </button>
                    </form>
                    {n.unread ? (
                      <form action={markReadAction}>
                        <input type="hidden" name="id" value={n.id} />
                        <button type="submit" className="ntf-mark" aria-label={`Mark “${n.title}” read`}>Mark read</button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}

        {page.next_cursor ? (
          <p className="ntf-more">
            <Link href={`${href({})}${href({}).includes('?') ? '&' : '?'}cursor=${encodeURIComponent(page.next_cursor)}`}>
              Older notifications
            </Link>
          </p>
        ) : null}
      </section>
    </PortalShell>
  );
}
