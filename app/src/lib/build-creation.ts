// Band B — "Create the build and invite": the wizard's pure contract (LINA-179).
//
// Everything here is a pure function or a frozen table, so the four screens stay
// about layout and the two things that are easy to get wrong are unit-testable
// without a DOM:
//
//   1. WHICH STEP a build is on. The wizard is draft-first (ADR-0011 decision 2):
//      the build row exists from step 1, so a half-finished build survives a
//      closed tab, a dropped connection, and a phone that went to sleep on a
//      jobsite. Resuming it correctly means deriving the step from the SERVER's
//      `status` + `operatingModel`, never from wizard-local state — see
//      `stepFor`.
//   2. WHICH ROLE the invite step may invite. The operating model decides it
//      (ADR-0011 §4 / OPERATING_MODEL_ROLES in services/identity/identity.mjs).
//      The service is the authority and 400s on a mismatch; this table exists so
//      the UI asks for the right thing and can LABEL it, not so the client gets
//      a vote.
//
// DESIGN SOURCE. The screens are `cowork/pen/linkNMS-flows.pen` → "Bootstrap
// Flow Board", screens 02–06, which is the surviving source of truth named by
// ADR-0011 (the PM spec `docs/product/build-creation-flow-spec.md` carrying
// AC-B1..B9 was never merged — flagged on this issue and on LINA-164). Where the
// pen asks for a field the shipped contract has no column for, the field is
// OMITTED and the gap is recorded here rather than rendered as an input that
// silently discards what the owner typed. See GAPS at the bottom.

export type OperatingModel = 'turnkey' | 'direct' | 'hybrid';
export type BuildStatus = 'draft' | 'active';
export type InviteRole = 'counterparty' | 'subcontractor';

// ── Creator role: "Who are you on this build?" (LINA-227, ADR-0016) ───────────
//
// The republished pen opens the New-build flow with a PRE-BASICS question —
// General contractor OR Owner — because the same account can be the owner on one
// build and the GC on another; the role is per build (ADR-0016 §1). The choice
// sets `creatorRole` on createProject:
//   * 'owner' (default) is the legacy owner-first path — creator is the owner,
//     owner_party_id is stamped at genesis, the first invite is the GC.
//   * 'counterparty' is a GC-created build — creator joins as the counterparty,
//     owner_party_id stays NULL until the invited HOMEOWNER accepts, and the
//     first invite's role inverts to `owner`.
//
// It is a PRE-WIZARD question, not a counted step: WIZARD_STEPS below is
// unchanged, so an owner's Basics/Model/Invite flow past this screen is
// byte-identical to before. Owner is pre-selected — the common case, and the
// default the service already assumes when `creatorRole` is absent.
export type CreatorRole = 'owner' | 'counterparty';

export const CREATOR_ROLES: readonly CreatorRole[] = Object.freeze(['owner', 'counterparty']);

export function isCreatorRole(v: unknown): v is CreatorRole {
  return v === 'owner' || v === 'counterparty';
}

/**
 * Copy for the two role cards on the pen's D2 "Your role" screen, plus the
 * Continue label the selection drives ("Continue as owner" / "…as general
 * contractor"). `tag` is the pen's small pill under each card — the one-line
 * consequence of the choice.
 */
export const CREATOR_ROLE_COPY: Readonly<
  Record<CreatorRole, { label: string; desc: string; tag: string; continueLabel: string }>
> = Object.freeze({
  owner: {
    label: 'Owner',
    desc: "I'm having this built. I create the project and invite my contractor to run the day-to-day, while I keep full visibility.",
    tag: 'Follows & approves',
    continueLabel: 'Continue as owner',
  },
  counterparty: {
    label: 'General contractor',
    desc: 'I run the build day-to-day — schedule, trades and budget. I set up the plan and invite the owner to follow along.',
    tag: 'Runs the timeline',
    continueLabel: 'Continue as general contractor',
  },
});

/**
 * The Basics screen's lede. It must read for a GC creator too (LINA-227) — the
 * screen no longer assumes the creator is the owner. Keyed by the creator role
 * the D2 screen chose and carried forward as `?as=`.
 */
export const BASICS_LEDE: Readonly<Record<CreatorRole, string>> = Object.freeze({
  owner: "You're setting up a build you own. Next you'll choose how it's run, then invite your contractor.",
  counterparty: "You're setting up a build you'll run. Next you'll choose how it's run, then invite the homeowner to follow along.",
});

/** The three models, in the pen's segmented-control order (screen 03). */
export const OPERATING_MODELS: readonly OperatingModel[] = Object.freeze([
  'turnkey',
  'direct',
  'hybrid',
]);

export function isOperatingModel(v: unknown): v is OperatingModel {
  return typeof v === 'string' && (OPERATING_MODELS as readonly string[]).includes(v);
}

/**
 * Copy for the segmented control. `blurb` is the pen's "short explainer per
 * option"; `consequence` is the part the pen states as a design note rather than
 * on-screen text — the choice is asked ONCE and never again, so the screen has to
 * say what it decides. An owner picking blind and discovering three weeks later
 * that they cannot invite their electrician directly is exactly the argument this
 * product exists to prevent.
 */
export const OPERATING_MODEL_COPY: Readonly<
  Record<OperatingModel, { label: string; blurb: string; consequence: string }>
> = Object.freeze({
  turnkey: {
    label: 'Turnkey',
    blurb: 'One general contractor is responsible for the whole build.',
    consequence: 'You invite one contractor. They own the master plan.',
  },
  direct: {
    label: 'Direct to specialty',
    blurb: 'You contract each trade yourself — electrician, plumber, carpenter.',
    consequence: 'You invite each specialty. Each one owns its own plan.',
  },
  hybrid: {
    label: 'Hybrid',
    blurb: 'A contractor for part of it, some trades contracted directly by you.',
    consequence: 'Both. Scope gaps between them get flagged for you to assign.',
  },
});

/**
 * Which role this build's first invite creates. Mirrors OPERATING_MODEL_ROLES in
 * services/identity/identity.mjs, restated here rather than imported: that module
 * is server-only, and a deliberate local restatement is what makes a contract
 * drift surface as a failing test in this file instead of as a 400 on the owner's
 * last wizard step.
 *
 * Hybrid admits BOTH roles server-side; V1 invites one party per wizard pass
 * (ADR-0011 OQ-3), and a Hybrid owner's first invite is the GC — the party who
 * runs the main build. A `null` model is a legacy pre-Band-B project, which keeps
 * R0 behaviour: the one GC counterparty.
 */
export function inviteRoleFor(model: OperatingModel | null | undefined): InviteRole {
  return model === 'direct' ? 'subcontractor' : 'counterparty';
}

/** How the invited party is named on screen. Never "counterparty" — that is a
 *  schema word, and nobody on a building site calls their electrician one. */
export const INVITE_ROLE_COPY: Readonly<
  Record<InviteRole, { noun: string; nounPlural: string; emailPlaceholder: string }>
> = Object.freeze({
  counterparty: {
    noun: 'general contractor',
    nounPlural: 'general contractors',
    emailPlaceholder: 'gc@example.com',
  },
  subcontractor: {
    noun: 'specialty contractor',
    nounPlural: 'specialty contractors',
    emailPlaceholder: 'electrician@example.com',
  },
});

/**
 * The inverted first invite (ADR-0016 §4). A GC-created build's first invite is
 * the HOMEOWNER — role `owner`, not one of the operating-model roles — so its
 * copy lives apart from INVITE_ROLE_COPY (which is keyed by InviteRole, a set
 * that never yields `owner`). Reached only while the build has no owner member
 * yet; once the homeowner joins, `owner` drops out of the invitable set
 * server-side, so this is exactly the one inverted invite and nothing after it.
 */
export const OWNER_INVITE_COPY = Object.freeze({
  noun: 'homeowner',
  nounPlural: 'homeowners',
  emailPlaceholder: 'owner@example.com',
});

// ── Steps ───────────────────────────────────────────────────────────────────
//
// Three steps, because three is what the owner is asked for. The pen's screen 05
// ("Invite sent") is the RESULT of step 3, not a fourth thing to do, and counting
// it would make the progress indicator read "3 of 4" on a finished wizard.

export const WIZARD_STEPS = Object.freeze([
  { key: 'basics', n: 1, label: 'Basics' },
  { key: 'model', n: 2, label: 'Operating model' },
  { key: 'invite', n: 3, label: 'Invite' },
] as const);

export type WizardStepKey = (typeof WIZARD_STEPS)[number]['key'];
export const TOTAL_STEPS = WIZARD_STEPS.length;

// ── Basics: build type (LINA-219) ────────────────────────────────────────────
//
// The pen's Basics screen draws Build type as a dropdown (example value "New
// single-family home"). The option list lives here as a frozen table so the
// <select> and any future validation read the same source. The VALUE is a stable
// slug and the LABEL is what the owner reads; the slug is what persists, so
// re-wording a label never rewrites stored data. The column has no DB CHECK
// (migration 0014) — this list is a UI affordance, not a schema constraint, so
// adding a type later is a one-line change here.
export const BUILD_TYPES = Object.freeze([
  { value: 'new-single-family', label: 'New single-family home' },
  { value: 'renovation', label: 'Renovation / remodel' },
  { value: 'extension', label: 'Extension / addition' },
  { value: 'multi-unit', label: 'Multi-unit / apartments' },
  { value: 'commercial', label: 'Commercial / mixed-use' },
  { value: 'other', label: 'Other' },
] as const);

export type BuildType = (typeof BUILD_TYPES)[number]['value'];

// ── Basics: expected start (LINA-219) ────────────────────────────────────────
//
// The pen draws Expected start as a MONTH picker showing "March 2026", not a
// free-form date field: the owner is stating the month they expect work to begin,
// a target and not a commitment, so day-precision would be false precision. The
// stored value stays "YYYY-MM" — the same shape the column already held when this
// was a native month input — so the change is the control, not the data.
//
// Pure and now-injected (never an argless `new Date()` in a shared module) so the
// list is testable: given a fixed "now", the options are deterministic.

const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

/** Two zero-padded digits for a 1-based month, e.g. 3 → "03". */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The next `count` months starting from `now`'s month, as `{ value, label }`
 * where value is "YYYY-MM" and label is "March 2026". 18 by default — a year and
 * a half is long enough for a not-yet-started build without turning the picker
 * into a scroll.
 */
export function expectedStartOptions(
  now: Date,
  count = 18,
): ReadonlyArray<{ value: string; label: string }> {
  const out: { value: string; label: string }[] = [];
  const year0 = now.getFullYear();
  const month0 = now.getMonth(); // 0-based
  for (let i = 0; i < count; i += 1) {
    const total = month0 + i;
    const year = year0 + Math.floor(total / 12);
    const month = total % 12; // 0-based
    out.push({
      value: `${year}-${pad2(month + 1)}`,
      label: `${MONTH_NAMES[month]} ${year}`,
    });
  }
  return Object.freeze(out);
}

/** The label an owner reads for a stored build-type slug; the slug itself as a
 *  fallback so an old value that predates a list change never renders blank. */
export function buildTypeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return BUILD_TYPES.find((t) => t.value === value)?.label ?? value;
}

/**
 * The step a build is on, derived from the server's projection alone.
 *
 * Truth table (ADR-0011 decisions 1–2):
 *   draft  + no model   → 'model'   — created, model not chosen
 *   draft  + model      → 'invite'  — model chosen, not yet committed
 *   active + any        → 'done'    — the first invite committed the build
 *
 * `undefined` status is a build read from an API that predates migration 0009.
 * Treated as 'done' rather than 'model': the conservative failure is to send the
 * owner to their existing build, not to re-run a wizard against a live record and
 * 409 on the operating-model PATCH.
 */
export function stepFor(build: {
  status?: BuildStatus;
  operatingModel?: OperatingModel | null;
}): WizardStepKey | 'done' {
  if (build.status !== 'draft') return 'done';
  return build.operatingModel ? 'invite' : 'model';
}

/** Where a resumed build should land. Pairs with `stepFor`, so a bookmarked step
 *  that no longer applies redirects instead of rendering a dead form. */
export function hrefForStep(projectId: string, step: WizardStepKey | 'done'): string {
  switch (step) {
    case 'basics':
      // The wizard entry `/projects/new` is now the pre-Basics "Your role"
      // screen (LINA-227); Basics itself moved one level down. `stepFor` never
      // returns 'basics' for a persisted build (a draft is already past it), so
      // this case is only the theoretical start-of-wizard target.
      return '/projects/new/basics';
    case 'model':
      return `/projects/${projectId}/operating-model`;
    case 'invite':
      return `/projects/${projectId}/invite`;
    case 'done':
      return `/projects/${projectId}`;
  }
}

// ── GAPS against the pen, recorded not silently dropped ─────────────────────
//
// CLOSED by LINA-219 (migration 0014): the Basics screen's "Site address",
// "Build type" and "Expected start" fields. They were originally omitted because
// migration 0009 added no columns for them, and a field that accepts what an
// owner types and then discards it is worse than its absence. Migration 0014 adds
// the three columns; createProject persists them and stamps them into the
// `project_created` genesis event, so the fields now render and are honoured.
//
// CLOSED by LINA-219 (baseline pen-rebuild): the Basics screen no longer draws a
// baseline budget, and the pen is right to omit it. Post-Slices-B1–B3 the PLAN is
// the baseline's source — import seeds the proposal and the accepted plan sets the
// authoritative figure — so typing a number up front is both redundant and a
// second, competing source of truth. A draft is now created with a 0 baseline
// (createBuildAction) and the plan establishes the real one; the genesis event
// still carries the baseline, it is just 0 until a plan is accepted. This retires
// the earlier "deliberate departure": the field's whole justification was that
// nothing else set the baseline, and B1–B3 now do.
//
// CLOSED by LINA-227 (ADR-0016): the pen's screen 01 "Who are you on this
// build?" role screen (owner OR general contractor can create a build). The
// backend inversion shipped in LINA-221 (creatorRole, nullable owner_party_id,
// the inverted first invite); this FE adds the pre-Basics D2 screen at
// `/projects/new`, carries the choice forward as `?as=`, and inverts the invite
// step's target to the homeowner for a GC-created build. Owner stays the default,
// so the owner path is unchanged.
//
// STILL OPEN (deferred to their own issues — backend features, not fidelity):
//   * The pen's new-build screen 04 Invite fields — invitee "Name or company",
//     the Role picker, and the "Scope note" textarea. `identity.invitation`
//     stores none of these (it is email + derived role only), so rendering them
//     would discard what the owner types. Same rule as always: no column, no
//     field. Adding the columns + the Hybrid role choice is its own slice.
//   * Pen "Resend / cancel invite" controls: ADR-0011 OQ-1 defers a re-send CTA
//     to a fast follow and settles on copy-link for V1, which is what the
//     invite-sent state ships.
