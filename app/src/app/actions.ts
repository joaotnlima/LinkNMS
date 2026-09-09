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

import {
  ApiError, PlanLimitError, type PlanLimit,
  createProject, createBuildDraft, setOperatingModel, inviteCounterparty, acceptInvitation,
} from '@/lib/api';
import { parseBudgetToCents } from '@/lib/format';
import { OPERATING_MODELS, inviteRoleFor, type OperatingModel } from '@/lib/build-creation';

export interface FormState {
  error?: string;
  /** Set on `409 plan_limit_reached` — see `refusal()` and PlanLimitNotice (LINA-205). */
  planLimit?: PlanLimit;
}

const message = (err: unknown, fallback: string): string =>
  (err instanceof ApiError ? err.message : null) ?? (err instanceof Error ? err.message : null) ?? fallback;

/**
 * `message()`, plus the plan allowance when the refusal carried one (LINA-205).
 *
 * Used on the CREATE paths only — they are the only ones the allowance gates.
 * Everywhere else keeps calling `message()` directly, so this cannot quietly
 * change what any other form renders.
 *
 * `error` is ALWAYS set, including when `planLimit` is: the service's own
 * sentence is the fallback for any surface that has not been taught the panel,
 * and a state that carried only numbers would render as silence there.
 */
const refusal = (err: unknown, fallback: string): FormState => ({
  error: message(err, fallback),
  ...(err instanceof PlanLimitError ? { planLimit: err.entitlement } : {}),
});

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
    return refusal(err, 'Could not create the project.');
  }
  // Straight to the invite step: a shared record with one party on it is not yet
  // doing anything for anyone (FR1 is create AND invite).
  redirect(`/projects/${id}/invite`);
}

// ── Band B: the build-creation wizard (LINA-179, ADR-0011) ──────────────────

/**
 * Wizard step 1 (M2/D2). Creates the build as a DRAFT and moves to step 2.
 *
 * Draft-first is the whole point (ADR-0011 decision 2): the owner's build exists
 * on the server the moment they name it, so a wizard abandoned at step 2 on a
 * phone is resumable rather than lost. It is not yet a shared record — nobody
 * else is on it until step 3's invite commits it.
 *
 * The pen's Basics fields — site address, build type, expected start — are
 * collected here and persisted (LINA-219, migration 0014); all three are optional
 * and blank posts store null server-side, so the required minimum is just the
 * name.
 *
 * NO BASELINE HERE (LINA-219 pen-rebuild). The pen dropped the baseline field and
 * post-Slices-B1–B3 that is correct: the plan is the baseline's source, so the
 * draft is created with a 0 baseline and the accepted plan sets the real figure.
 * A draft is not a live record — it commits on the first invite (step 3) — and by
 * then the owner has walked through the plan; collecting a number twice, from two
 * competing sources, is the drift this avoids. See build-creation's GAPS note.
 */
export async function createBuildAction(_prev: FormState, form: FormData): Promise<FormState> {
  const name = String(form.get('name') ?? '').trim();
  if (!name) return { error: 'Give the build a name.' };

  // Optional Basics fields. Trimmed here and only forwarded when non-empty; the
  // service is the authority on caps and stores null for blanks regardless.
  const siteAddress = String(form.get('siteAddress') ?? '').trim() || undefined;
  const buildType = String(form.get('buildType') ?? '').trim() || undefined;
  const expectedStart = String(form.get('expectedStart') ?? '').trim() || undefined;

  let id: string;
  try {
    // Draft baseline is 0; the plan establishes the authoritative figure.
    ({ id } = await createBuildDraft({ name, baselineBudgetCents: 0, siteAddress, buildType, expectedStart }));
  } catch (err) {
    // The path that fires for real today: a founding seat runs one build, so the
    // owner's SECOND trip through the wizard lands here (ADR-0013).
    return refusal(err, 'Could not create the build.');
  }
  redirect(`/projects/${id}/operating-model`);
}

/**
 * Wizard step 2 (M3/D3). Sets the operating model and moves to the invite step.
 *
 * The value is checked against the frozen list before the call — not as a
 * substitute for the service's own validation (it rejects anything outside the
 * three regardless) but so a mangled form post is a sentence beside the control
 * rather than a 400 the owner has to interpret.
 */
export async function setOperatingModelAction(_prev: FormState, form: FormData): Promise<FormState> {
  const projectId = String(form.get('projectId') ?? '');
  if (!projectId) return { error: 'Missing build.' };

  const choice = String(form.get('operatingModel') ?? '');
  if (!OPERATING_MODELS.includes(choice as OperatingModel)) {
    return { error: 'Choose how this build is run.' };
  }

  try {
    await setOperatingModel(projectId, choice as OperatingModel);
  } catch (err) {
    return { error: message(err, 'Could not save how this build is run.') };
  }
  redirect(`/projects/${projectId}/invite`);
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

  // Band B (ADR-0011 §4): which role this build may invite follows its operating
  // model. The model is read from the hidden field the invite screen rendered
  // from the SERVER's projection, and it is mapped through `inviteRoleFor` — the
  // form never posts a role directly, so a tampered field can at worst name a
  // different model, and the service then rejects a role that build does not
  // admit. A legacy project (no model) falls through to `counterparty`, R0's
  // behaviour, unchanged.
  const role = inviteRoleFor(String(form.get('operatingModel') ?? '') as OperatingModel);

  try {
    const { token, emailed } = await inviteCounterparty(projectId, email || undefined, role);
    // This invite is what commits a draft build (draft→active). Revalidate the
    // build's own route so the record the owner lands on is the committed one,
    // not a cached draft.
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
