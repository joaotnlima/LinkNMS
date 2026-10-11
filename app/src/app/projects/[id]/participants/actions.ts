'use server';

// The PartyInvite (PRD-09 O-4). The server decides who may invite (owner or
// prime contractor) and validates again; this parses the form, sends it, and
// hands the one-time accept link back to the inviter — the only place the
// token ever appears (it is stored hashed). No email leaves yet: the inviter
// forwards the link (the notifications slice owns invitation e-mail).
import { revalidatePath } from 'next/cache';

import type { ActionState } from '@/components/ActionForm';
import { V2Error } from '@/lib/v2/client';
import { inviteParty } from '@/lib/v2/participants';
import { parseInviteForm } from '@/lib/v2/participants-view';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function invitePartyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const projectId = String(form.get('projectId') ?? '');
  if (!UUID.test(projectId)) return { error: 'This build could not be found.' };
  const parsed = parseInviteForm((k) => (form.get(k) == null ? null : String(form.get(k))));
  if (!parsed.body) return { error: parsed.error };
  try {
    const inv = await inviteParty(projectId, parsed.body);
    revalidatePath(`/projects/${projectId}/participants`);
    return { token: inv.token, sentTo: inv.email, emailed: false };
  } catch (err) {
    if (err instanceof V2Error) {
      const field = err.errors ? Object.values(err.errors)[0] : null;
      return { error: field ? `Couldn't send the invitation: ${field}.` : `Couldn't send the invitation: ${err.message}` };
    }
    throw err;
  }
}
