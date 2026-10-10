// Pure v2-wire → view transforms for the notification centre (PRD-12 N-1, N-2).
// Split from `notifications.ts` (the I/O, `server-only`) so the grouping and the
// preference rows are unit-testable without a session. Nothing here decides who
// is notified or where a notification leads — the server answers both (the deep
// link is `object_ref.url`); this only arranges what came back for the screen.

export type NotificationCategory =
  | 'bids' | 'tendering' | 'variations' | 'invitations' | 'questions' | 'quality' | 'files';

export interface V2Notification {
  id: string;
  category: NotificationCategory | string;
  title: string;
  object_ref: { type: string; id: string; project_id?: string; url: string; count?: number };
  created_at: string;
  read_at: string | null;
}

export interface V2NotificationPage {
  items: V2Notification[];
  next_cursor: string | null;
  unread_count: number;
}

export interface V2NotificationPreference {
  category: NotificationCategory | string;
  channel: 'in_app' | 'email';
  enabled: boolean;
}

/** Labels for the categories the contract enumerates, in settings order. */
export const CATEGORY_LABEL: Record<NotificationCategory, { label: string; hint: string }> = {
  bids: { label: 'Bids received', hint: 'A company answered a tender you sent' },
  tendering: { label: 'Tenders you bid on', hint: 'Clarifications answered, awards and cancellations' },
  variations: { label: 'Plan changes', hint: 'One digest per 15 minutes of changes on your builds' },
  invitations: { label: 'Invitations', hint: 'Someone accepted your invitation to a build' },
  questions: { label: 'Questions', hint: 'Questions addressed to you and their answers' },
  quality: { label: 'Quality', hint: 'Non-conformities assigned to your company' },
  files: { label: 'Files & deliverables', hint: 'Deliverables to review or reviewed, new versions of files on your tasks' },
};

export function categoryLabel(category: string): string {
  return (CATEGORY_LABEL as Record<string, { label: string }>)[category]?.label ?? category;
}

export interface NotificationItemView {
  id: string;
  title: string;
  category: string;
  categoryLabel: string;
  url: string;
  unread: boolean;
  at: string; // ISO, rendered by the page
}

export interface NotificationGroup {
  key: 'today' | 'yesterday' | 'earlier';
  label: string;
  items: NotificationItemView[];
}

const DAY_MS = 86_400_000;

/**
 * Group newest-first items into Today / Yesterday / Earlier (calendar days in
 * UTC — the server stamps RFC 3339 UTC). Empty groups are dropped; order kept.
 */
export function groupNotifications(items: V2Notification[], now: Date = new Date()): NotificationGroup[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const groups: NotificationGroup[] = [
    { key: 'today', label: 'Today', items: [] },
    { key: 'yesterday', label: 'Yesterday', items: [] },
    { key: 'earlier', label: 'Earlier', items: [] },
  ];
  for (const n of items) {
    const t = Date.parse(n.created_at);
    const g = t >= today ? 0 : t >= today - DAY_MS ? 1 : 2;
    groups[g].items.push({
      id: n.id,
      title: n.title,
      category: n.category,
      categoryLabel: categoryLabel(n.category),
      url: safeAppPath(n.object_ref?.url),
      unread: n.read_at == null,
      at: n.created_at,
    });
  }
  return groups.filter((g) => g.items.length > 0);
}

/**
 * The deep link is app-relative by contract; anything else (absolute, protocol-
 * relative, missing) falls back to the centre itself — never an open redirect.
 */
export function safeAppPath(url: string | undefined | null): string {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) {
    return '/notifications';
  }
  return url;
}

export interface PreferenceRow {
  category: string;
  label: string;
  hint: string;
  inApp: boolean;
  email: boolean;
}

/** One row per category the server answered (catalogue order kept). */
export function preferenceRows(prefs: V2NotificationPreference[]): PreferenceRow[] {
  const rows = new Map<string, PreferenceRow>();
  for (const p of prefs) {
    const meta = (CATEGORY_LABEL as Record<string, { label: string; hint: string }>)[p.category];
    const row = rows.get(p.category) ?? {
      category: p.category, label: meta?.label ?? p.category, hint: meta?.hint ?? '', inApp: true, email: true,
    };
    if (p.channel === 'in_app') row.inApp = p.enabled;
    if (p.channel === 'email') row.email = p.enabled;
    rows.set(p.category, row);
  }
  return [...rows.values()];
}

/**
 * Form → the PUT body: every category × channel the form showed, checked or
 * not (an unchecked box is absent from FormData, which is exactly "off").
 */
export function preferencesFromForm(categories: string[], checked: (name: string) => boolean): V2NotificationPreference[] {
  return categories.flatMap((category) => [
    { category, channel: 'in_app' as const, enabled: checked(`${category}:in_app`) },
    { category, channel: 'email' as const, enabled: checked(`${category}:email`) },
  ]);
}

/** The bell's badge text: nothing at zero, "99+" past 99. */
export function badgeText(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > 99 ? '99+' : String(Math.floor(unread));
}
