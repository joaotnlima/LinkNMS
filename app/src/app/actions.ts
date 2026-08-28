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
import { cookies } from 'next/headers';

import { ApiError, createProject, inviteCounterparty, acceptInvitation } from '@/lib/api';
import { parseBudgetToCents } from '@/lib/format';
import { signIn, SESSION_COOKIE, sessionCookieOptions } from '@/server/signin';

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

export interface InviteState extends FormState { token?: string }

/**
 * ⚠️ The raw invitation token comes back exactly once and is NEVER persisted —
 * only its SHA-256 is. It is returned to the page so the owner can hand it over,
 * and it must not be logged, revalidated into a cache, or sent to analytics.
 */
export async function inviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const projectId = String(form.get('projectId') ?? '');
  if (!projectId) return { error: 'Missing project.' };
  try {
    const { token } = await inviteCounterparty(projectId);
    revalidatePath(`/projects/${projectId}`);
    return { token };
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

// ── Sign-in ──────────────────────────────────────────────────────────────────

export async function signInAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get('email') ?? '').trim();
  const displayName = String(form.get('displayName') ?? '').trim();
  const next = String(form.get('next') ?? '/');

  let token: string;
  try {
    ({ token } = await signIn({ email, displayName: displayName || undefined }));
  } catch (err) {
    return { error: message(err, 'Could not sign in.') };
  }
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
  // Only ever redirect to a path on this origin — a `next` that could carry an
  // absolute URL turns the sign-in form into an open redirect.
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export async function signOutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/');
}
