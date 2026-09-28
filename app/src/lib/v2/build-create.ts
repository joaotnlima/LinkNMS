// The v2 build-creation field mapping (LINA-365) — the PURE half of the creation
// seam, kept free of `server-only`/`./client` so it is unit-testable without a
// session (the plan-apply.ts / planning.ts split). The I/O wrapper that mints the
// id and POSTs lives in `./build.ts`.
//
// ── THE V1→V2 FIELD MAPPING (the contract this pins down) ─────────────────────
// The v1 `ProjectCreate` (identity.createProject) and the v2 one
// (project.createProject, openapi `ProjectCreate`) are different shapes; this is
// the one place the wizard's fields are translated, so a drift is reviewable in
// one diff:
//
//   wizard field            → v2 ProjectCreate
//   ─────────────────────────────────────────────────────────────────────────
//   name                    → name                 (required, trimmed)
//   (client-minted)         → id                   (UUID, minted in build.ts —
//                                                    v2 is client-generated-id)
//   municipalityCode        → municipality_code    (REQUIRED by v2, see GAP-1)
//   siteAddress             → address              (optional; omitted when blank)
//   buildType               → typology             (optional; omitted when blank)
//   onBehalfOfOwnerEmail    → on_behalf_of_owner_email (supplier-created draft)
//
// DELIBERATELY NOT SENT (and why):
//   • baseline / indicative_budget — the plan is the baseline's single source
//     (LINA-219); a v2 draft carries no budget and the accepted plan sets the
//     real figure. Sending a 0 here would be a second, competing source.
//   • creatorRole, hasSignedContractor, expectedStart — these shaped v1's
//     seed-time OPERATING MODEL and PHASE state, which v2 models through separate
//     endpoints (participants, planning phases), NOT the project brief. They are
//     carried by the participation / phase-seed increments, not the create call.
//     `expectedStart` has no v2 brief field at all today (GAP-2).
//
// ── GAPS raised to the wiring increment (do not paper over here) ──────────────
//   GAP-1  v2 requires `municipality_code`; the pen Basics screen does not
//          collect it. The wiring increment MUST add the field to Basics — this
//          seam refuses a blank rather than send a placeholder that would pollute
//          a real record (the product's whole promise is truthful data).
//   GAP-2  `expectedStart` is dropped. If the product wants it on v2, the brief
//          schema needs a field (an openapi + module change), not a client hack.

/** The wizard's inputs to a fresh build, pre-translation. Blank optionals are
 *  omitted from the wire body, never sent as empty strings. */
export interface BuildDraftV2Input {
  /** The build's name. Required; trimmed. */
  name: string;
  /**
   * The municipality code the brief is filed under. REQUIRED by v2
   * (`municipality_code`), unlike the v1 wizard — see GAP-1. Trimmed; a blank
   * value is a programmer error here (the form must validate first) and throws.
   */
  municipalityCode: string;
  /** Site address → v2 `address`. Optional; omitted when blank. */
  siteAddress?: string;
  /** Build type → v2 `typology`. Optional; omitted when blank. */
  buildType?: string;
  /**
   * A supplier creating the build for an owner who must later claim it
   * (`on_behalf_of_owner_email`, doc 14 Q4). Optional; omitted when blank.
   */
  onBehalfOfOwnerEmail?: string;
}

/** The `ProjectCreate` wire body, exactly as openapi `ProjectCreate` requires.
 *  Only the fields this seam sends — the create call carries no budget. */
export interface ProjectCreateBody {
  id: string;
  name: string;
  municipality_code: string;
  address?: string;
  typology?: string;
  on_behalf_of_owner_email?: string;
}

const clean = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/**
 * Pure wizard-input → `ProjectCreate` body, with the id already minted. Throws on
 * a blank name or municipality code: those are required by v2 and the form is
 * expected to have validated them, so reaching here blank is a defect, not a user
 * error to render.
 */
export function toProjectCreateBody(input: BuildDraftV2Input, id: string): ProjectCreateBody {
  const name = input.name?.trim();
  if (!name) throw new Error('build name is required');
  const municipalityCode = input.municipalityCode?.trim();
  if (!municipalityCode) throw new Error('municipality code is required (GAP-1: Basics must collect it)');

  const body: ProjectCreateBody = { id, name, municipality_code: municipalityCode };
  const address = clean(input.siteAddress);
  if (address) body.address = address;
  const typology = clean(input.buildType);
  if (typology) body.typology = typology;
  const onBehalf = clean(input.onBehalfOfOwnerEmail);
  if (onBehalf) body.on_behalf_of_owner_email = onBehalf.toLowerCase();
  return body;
}
