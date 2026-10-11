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

import {
  ApiError, PlanLimitError, type PlanLimit,
} from '@/lib/api';
import { createBuildDraftV2 } from '@/lib/v2/build';
import { parseBuildPoint } from '@/lib/v2/build-create';
import { acceptInvitation } from '@/lib/v2/invitations';

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

// ── Band B: the build-creation wizard (LINA-179, ADR-0011) ──────────────────
//
// The wizard is a SINGLE creation step on v2 (LINA-386, realizing LINA-367
// Option A): Basics creates the draft on `/api/v2` and lands on the record. The
// v1 tail — the FR1 `createProjectAction`, the operating-model step
// (`setOperatingModelAction`) and the counterparty invite (`inviteAction`) — is
// gone: operating-model is DROPPED and invite is DEFERRED to its own v2
// participation slice, so no wizard write touches `/api/v1` any more. The invitee
// side (`acceptInviteAction`, below) is now on `/api/v2` too (LINA-398) — the v1
// identity invitation slice is retired.

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

  // GAP-1 (LINA-365): the v2 project brief REQUIRES a municipality code. Basics
  // now collects it (`required` on the field), but a mangled post could still
  // arrive blank — the seam throws on blank rather than store a placeholder, so
  // catch it here as a sentence beside the input, not a 400.
  const municipalityCode = String(form.get('municipalityCode') ?? '').trim();
  if (!municipalityCode) return { error: 'Enter the municipality code the build is filed under.' };

  // Optional Basics fields. Trimmed here and only forwarded when non-empty; the
  // service stores null for blanks regardless.
  const siteAddress = String(form.get('siteAddress') ?? '').trim() || undefined;
  const buildType = String(form.get('buildType') ?? '').trim() || undefined;
  // PRD-03 R-3: the optional point, for "companies near this build".
  const point = parseBuildPoint(String(form.get('locationLat') ?? ''), String(form.get('locationLng') ?? ''));
  if (point.error) return { error: point.error };

  // PRD-09 O-13: the creator role is persisted the one way the v2 model has —
  // a GC creating for an owner sends the owner's email (on_behalf_of_owner_email,
  // doc 14 Q4) and the owner claims the build. Expected start and "signed
  // contractor?" are no longer asked: the plan's dates and the awarded tenders
  // carry them (D-24, D-35, D-43). The seam maps the rest (build-create.ts).
  const creatorRole = String(form.get('creatorRole') ?? 'owner');
  let onBehalfOfOwnerEmail: string | undefined;
  if (creatorRole === 'counterparty') {
    onBehalfOfOwnerEmail = String(form.get('ownerEmail') ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(onBehalfOfOwnerEmail)) {
      return { error: 'Enter the owner\u2019s email — they claim the build by signing in with it.' };
    }
  }

  let id: string;
  try {
    // Draft baseline is 0; the accepted plan establishes the authoritative figure
    // (LINA-219). The v2 draft carries no budget at all.
    ({ id } = await createBuildDraftV2({ name, municipalityCode, siteAddress, buildType, location: point.location, onBehalfOfOwnerEmail }));
  } catch (err) {
    // A viewer with no active v2 org / lacking org:projects:create gets a V2Error
    // here (the onboarding org-provisioning increment makes a fresh signup have
    // one). Its problem+json message is already user-facing; `message()` surfaces
    // it verbatim, so no v2-specific branch is needed.
    return refusal(err, 'Could not create the build.');
  }
  // Straight to the build home (PRD-09 O-1): the plan import and the
  // participants page start there.
  redirect(`/projects/${id}`);
}

// ── Invitee side: accept an invitation ───────────────────────────────────────

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
