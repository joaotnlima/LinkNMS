'use server';

// Claiming an unclaimed profile (PRD-03 R-16). Start: the server mails a
// single-use link to the profile's e-mail and answers the masked address.
// Accept: the e-mailed token, posted by the organisation that started it.
// Both are POSTs from a page — never a side effect of opening a link.
import { redirect } from 'next/navigation';

import { V2Error } from '@/lib/v2/client';
import { acceptProfileClaim, claimProfile } from '@/lib/v2/directory';

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

export async function startClaimAction(fd: FormData): Promise<void> {
  const slug = str(fd, 'slug');
  let target: string;
  try {
    const { sent_to } = await claimProfile(str(fd, 'org_id'));
    target = `/companies/${slug}/claim?sent=${encodeURIComponent(sent_to)}`;
  } catch (err) {
    if (!(err instanceof V2Error)) throw err;
    target = `/companies/${slug}/claim?error=${encodeURIComponent(err.message)}`;
  }
  redirect(target);
}

export async function acceptClaimAction(fd: FormData): Promise<void> {
  const slug = str(fd, 'slug');
  const token = str(fd, 'token');
  let target = '/settings/organization/profile?saved=claimed';
  try {
    await acceptProfileClaim(token);
  } catch (err) {
    if (!(err instanceof V2Error)) throw err;
    const why = err.code === 'gone' ? 'This link is no longer valid — ask for a new one.' : err.message;
    target = `/companies/${slug}/claim/${encodeURIComponent(token)}?error=${encodeURIComponent(why)}`;
  }
  redirect(target);
}
