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
    blurb: 'One general contractor runs the whole build and hires their own trades.',
    consequence: 'You invite one general contractor. They answer for the work and the cost.',
  },
  direct: {
    label: 'Direct-to-specialty',
    blurb: 'You contract each trade yourself — electrician, plumber, roofer.',
    consequence: 'You invite specialty contractors directly. There is no general contractor above them.',
  },
  hybrid: {
    label: 'Hybrid',
    blurb: 'A general contractor for the main build, plus trades you hold directly.',
    consequence: 'You can invite either a general contractor or a specialty contractor.',
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

// ── Steps ───────────────────────────────────────────────────────────────────
//
// Three steps, because three is what the owner is asked for. The pen's screen 05
// ("Invite sent") is the RESULT of step 3, not a fourth thing to do, and counting
// it would make the progress indicator read "3 of 4" on a finished wizard.

export const WIZARD_STEPS = Object.freeze([
  { key: 'basics', n: 1, label: 'Basics' },
  { key: 'model', n: 2, label: 'How it is run' },
  { key: 'invite', n: 3, label: 'Invite' },
] as const);

export type WizardStepKey = (typeof WIZARD_STEPS)[number]['key'];
export const TOTAL_STEPS = WIZARD_STEPS.length;

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
      return '/projects/new';
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
// Pen screen 02 draws a "Site address" field and a "Build type" selector; pen
// screen 04 draws a "Scope note" textarea. Migration 0009 added exactly two
// columns to `identity.project` (`operating_model`, `status`) and
// `identity.invitation` gained no note column, so there is nowhere for any of the
// three to land. They are NOT rendered: a field that accepts what an owner types
// about their site and then discards it is worse than its absence on a product
// whose promise is that the record is what was agreed.
//
// Tracked for the Architect / Back-End on LINA-179's follow-up; when the columns
// exist the fields belong on screens 02 and 04 respectively, with no other change
// to this flow.
//
// Likewise the pen's screen 05 "Resend / cancel invite" controls: ADR-0011 OQ-1
// defers a re-send CTA to a fast follow and settles on copy-link for V1, which is
// what the invite-sent state ships.
