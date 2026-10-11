'use server';

// The company inbox's two writes (PRD-04 X-9, X-10): ask to bid on an open
// request (a pending request — D-47: the owner approves), and decline an
// invitation. Plain form actions: the result rides back on the URL as a flash
// (`?done=` / `?error=`), the page re-reads the server's state.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { askToBid, declineInvitation } from '@/lib/v2/company-inbox';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function back(tab: 'for-you' | 'near', flash: { done?: string; error?: string }): never {
  const usp = new URLSearchParams({ tab });
  if (flash.done) usp.set('done', flash.done);
  if (flash.error) usp.set('error', flash.error);
  redirect(`/requests?${usp.toString()}`);
}

export async function askToBidAction(form: FormData): Promise<void> {
  const rfpId = String(form.get('rfp_id') ?? '');
  if (!UUID.test(rfpId)) back('near', { error: 'That request could not be found.' });
  const res = await askToBid(rfpId);
  revalidatePath('/requests');
  if (!res.ok) back('near', { error: res.message });
  back('near', { done: 'Asked. The owner decides — you get a notification and, if approved, your personal link.' });
}

export async function declineInvitationAction(form: FormData): Promise<void> {
  const rfpId = String(form.get('rfp_id') ?? '');
  if (!UUID.test(rfpId)) back('for-you', { error: 'That request could not be found.' });
  const res = await declineInvitation(rfpId);
  revalidatePath('/requests');
  if (!res.ok) back('for-you', { error: res.message });
  back('for-you', { done: 'Declined. The issuer sees that you will not bid.' });
}
