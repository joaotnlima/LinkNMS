'use server';

// The notification centre's writes (PRD-12 N-2): open (mark read, then follow
// the deep link), mark one read, mark all read. Server actions because the v2
// client is server-only. The deep link is re-checked as app-relative here — it
// came from the server, but a form field is still user input.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { markNotificationsRead } from '@/lib/v2/notifications';
import { safeAppPath } from '@/lib/v2/notifications-view';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function openNotificationAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const to = safeAppPath(String(formData.get('url') ?? ''));
  if (UUID.test(id)) {
    try {
      await markNotificationsRead({ ids: [id] });
    } catch {
      // Opening must never be blocked by the read stamp; the row stays unread.
    }
  }
  revalidatePath('/notifications');
  redirect(to);
}

export async function markReadAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  if (UUID.test(id)) await markNotificationsRead({ ids: [id] });
  revalidatePath('/notifications');
}

export async function markAllReadAction(): Promise<void> {
  await markNotificationsRead({ all: true });
  revalidatePath('/notifications');
}
