'use server';

// Server actions for the write flows the R0 surfaces need (LINA-57).
//
// These are thin: validate the form fields into the shapes the API already
// specifies, call `@/lib/api`, and translate a failure into a message the form
// can render. No domain logic, no budget arithmetic, no authorization — the
// services own all three, and the acting party comes from the session cookie,
// never from a hidden field.
//
// Every action returns `{ error }` rather than throwing, because a rejected
// change order or an invalid budget is a NORMAL outcome that belongs beside the
// input that caused it, not on an error page.
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { ApiError, createProject, inviteCounterparty, acceptInvitation } from '@/lib/api';
import { parseBudgetToCents } from '@/lib/format';

export interface FormState { error?: string }

const message = (err: unknown, fallback: string): string =>
  (err instanceof ApiError ? err.message : null) ?? (err instanceof Error ? err.message : null) ?? fallback;

// ── FR1: start a shared record ───────────────────────────────────────────────

export async function createProjectAction(_prev: FormState, form: FormData): Promise<FormState> {
  const name = String(form.get('name') ?? '').trim();
  if (!name) return { error: 'Give the project a name.' };

  let baselineBudgetCents: number;
  try {
    baselineBudgetCents = parseBudgetToCents(String(form.get('baselineBudget') ?? ''));
  } catch (err) {
    return { error: message(err, 'That baseline budget is not a valid amount.') };
  }

  let id: string;
  try {
    ({ id } = await createProject({ name, baselineBudgetCents }));
  } catch (err) {
    return { error: message(err, 'Could not create the project.') };
  }
  // Straight to the invite step: a shared record with one party on it is not yet
  // doing anything for anyone (FR1 is create AND invite).
  redirect(`/projects/${id}/invite`);
}

// ── FR1: invite the GC ───────────────────────────────────────────────────────

export interface InviteState extends FormState {
  token?: string;
  /** The address it was mailed to, echoed back for the confirmation copy. */
  sentTo?: string;
  /** True only when the server actually handed the message to the mailer. */
  emailed?: boolean;
}

/**
 * ⚠️ The raw invitation token comes back exactly once and is NEVER persisted —
 * only its SHA-256 is. It is returned to the page so the owner can hand it over,
 * and it must not be logged, revalidated into a cache, or sent to analytics.
 *
 * The email is OPTIONAL (LINA-84). With one, the GC is mailed the accept link;
 * without one, this is the unchanged copy-the-code flow. The token is surfaced
 * in BOTH cases on purpose — if delivery fails the owner is not stranded, they
 * still have a link to send by hand.
 */
export async function inviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const projectId = String(form.get('projectId') ?? '');
  if (!projectId) return { error: 'Missing project.' };
  const email = String(form.get('email') ?? '').trim();
  try {
    const { token, emailed } = await inviteCounterparty(projectId, email || undefined);
    revalidatePath(`/projects/${projectId}`);
    return { token, emailed, ...(email ? { sentTo: email } : {}) };
  } catch (err) {
    return { error: message(err, 'Could not create an invitation.') };
  }
}

export async function acceptInviteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const token = String(form.get('token') ?? '').trim();
  if (!token) return { error: 'Paste the invitation code you were sent.' };
  let projectId: string;
  try {
    ({ projectId } = await acceptInvitation(token));
  } catch (err) {
    return { error: message(err, 'That invitation could not be accepted.') };
  }
  redirect(`/projects/${projectId}`);
}

// ── Sign-in ─────────────────────────────────────────────────────────────────
//
// There are no sign-in actions here any more (LINA-124, Auth Migration 0B).
// `signInAction` (the `LINKNMS_OPEN_SIGNIN` no-proof door), `requestSignInLinkAction`
// (the magic-link request, LINA-76) and `signOutAction` (which deleted the
// `lnms_session` cookie) are all deleted. Clerk owns establishing and ending a
// session: /sign-in and /sign-up render its components, and signing out is
// `useClerk().signOut()` in the browser. A server action that mints or clears a
// session would be a SECOND authority on who is acting — the exact drift the
// gateway's own comments warn about.
