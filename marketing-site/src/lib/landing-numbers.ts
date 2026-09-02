// The landing page's single source of numeric truth (LINA-83).
//
// The whole claim of this page is "the numbers agree". They cannot agree if
// each section retypes them, so every euro figure, count and percentage that
// appears anywhere on the landing page is declared here exactly once and
// imported. Copy strings in `messages/*.json` carry ICU placeholders and are
// filled from these values — never with a literal number.
//
// Ground truth: `landing-page-redesign-spec` §1 and the `landing-page` /
// `key-frames` frames of `cowork/pen/linkNMS.pen`.

/** Contract total after every signed change. Appears in S3, S4, S5 and the phone preview. */
export const CONTRACT_TOTAL = 97_100;

/** The figure on the March quote, before any change. The hero's "you said €X". */
export const ORIGINAL_QUOTE = 82_400;

/** Materials slice of the contract total, and its movement since March. */
export const MATERIALS = 25_246;
export const MATERIALS_DELTA_SINCE_MARCH = 3_200;

/** Plan shape as parsed out of the uploaded spreadsheet (S4). */
export const WORK_PACKAGES = 6;
export const SUB_TASKS = 41;
export const ROWS_READ = 342;

/** Source spreadsheet filename shown in the S4 file bar. */
export const PLAN_FILENAME = 'Orcamento_Moradia_Vale_V3.xlsx';

/**
 * Materials share of the contract total, as a whole percent.
 * Derived, not typed: 25,246 / 97,100 = 26%.
 */
export const MATERIALS_SHARE_PCT = Math.round((MATERIALS / CONTRACT_TOTAL) * 100);

/**
 * The six work packages of the plan (S3 gantt, S4 table).
 *
 * `state` is the plan semantic, not a colour: 'baseline' = agreed and unmoved,
 * 'actual' = moved by a signed change, 'closed' = finished with both readings
 * kept. The renderer maps these to --plan-baseline / --plan-actual / --plan-closed.
 *
 * `plannedOffset` / `plannedWidth` / `actualOffset` / `actualWidth` are the
 * gantt geometry from the `landing-page` frame, in the frame's 944px track
 * units. The renderer scales them; it does not reinterpret them.
 */
export type PlanState = 'baseline' | 'actual' | 'closed';

export type WorkPackage = {
  key: string;
  /** Euro value of the package. The six values sum to CONTRACT_TOTAL. */
  value: number;
  /** Signed change against the baseline, if any. */
  delta?: number;
  state: PlanState;
  plannedOffset: number;
  plannedWidth: number;
  actualOffset: number;
  actualWidth: number;
};

export const WORK_PACKAGE_ROWS: readonly WorkPackage[] = [
  { key: 'foundations', value: 9_400, state: 'actual', plannedOffset: 0, plannedWidth: 120, actualOffset: 0, actualWidth: 150 },
  { key: 'structure', value: 24_100, delta: 1_700, state: 'actual', plannedOffset: 120, plannedWidth: 180, actualOffset: 120, actualWidth: 150 },
  { key: 'envelope', value: 18_900, state: 'actual', plannedOffset: 300, plannedWidth: 150, actualOffset: 330, actualWidth: 150 },
  { key: 'cladding', value: 12_600, delta: 3_200, state: 'actual', plannedOffset: 450, plannedWidth: 120, actualOffset: 480, actualWidth: 120 },
  { key: 'mep', value: 15_800, state: 'closed', plannedOffset: 510, plannedWidth: 180, actualOffset: 540, actualWidth: 180 },
  { key: 'finishes', value: 16_300, state: 'closed', plannedOffset: 690, plannedWidth: 240, actualOffset: 690, actualWidth: 240 }
] as const;

/** Width of the gantt track in the source frame. Geometry above is in these units. */
export const GANTT_TRACK_UNITS = 944;

/** Months spanned by the gantt header. */
export const GANTT_MONTHS = ['MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT'] as const;

/**
 * Budget composition bar (S5).
 *
 * The five slices in the design frame sum to €97,096 — four euros short of the
 * contract total. Rather than ship a page that contradicts itself four euros at
 * a time, the last slice is *derived* as the remainder so the bar always sums to
 * CONTRACT_TOTAL exactly. Flagged to the architect on LINA-83; if the intended
 * fix is a different slice, change it here and every section follows.
 */
const COMPOSITION_FIXED = [
  { key: 'structure', value: 32_990 },
  { key: 'envelope', value: 19_450 },
  { key: 'materials', value: MATERIALS, highlight: true },
  { key: 'mep', value: 11_600 }
] as const;

export const BUDGET_COMPOSITION: readonly { key: string; value: number; highlight?: boolean }[] = [
  ...COMPOSITION_FIXED,
  {
    key: 'finishes',
    value: CONTRACT_TOTAL - COMPOSITION_FIXED.reduce((sum, slice) => sum + slice.value, 0)
  }
];

/** The S4 parsed-plan table: two work packages expanded into their sub-tasks. */
export const PLAN_TABLE: readonly {
  key: string;
  total: number;
  rows: readonly { key: string; qty: number; unit: string; unitPrice: number; total: number }[];
}[] = [
  {
    key: 'structure',
    total: 24_100,
    rows: [
      { key: 'slab', qty: 46, unit: 'm²', unitPrice: 118, total: 5_428 },
      { key: 'timber', qty: 1, unit: 'lot', unitPrice: 12_400, total: 12_400 },
      { key: 'steel', qty: 1, unit: 'lot', unitPrice: 6_272, total: 6_272 }
    ]
  },
  {
    key: 'cladding',
    total: 12_600,
    rows: [
      { key: 'brick', qty: 88, unit: 'm²', unitPrice: 74, total: 6_512 },
      { key: 'glazing', qty: 11, unit: 'un', unitPrice: 553, total: 6_088 }
    ]
  }
];

/**
 * The S5 material swap. Totals are derived from unit price × area so the
 * saving cannot drift from the two lines it is the difference of.
 */
export const MATERIAL_SWAP = {
  area: 96,
  unit: 'm²',
  from: { key: 'oak', unitPrice: 68 },
  to: { key: 'porcelain', unitPrice: 41 },
  approvedBy: 'Marta',
  approvedOn: '2026-05-14T09:12:00'
} as const;

export const MATERIAL_SWAP_FROM_TOTAL = MATERIAL_SWAP.from.unitPrice * MATERIAL_SWAP.area;
export const MATERIAL_SWAP_TO_TOTAL = MATERIAL_SWAP.to.unitPrice * MATERIAL_SWAP.area;
export const MATERIAL_SWAP_SAVING = MATERIAL_SWAP_FROM_TOTAL - MATERIAL_SWAP_TO_TOTAL;

/**
 * Bar-lane geometry shared by every PlanTrack on the page.
 *
 * The gantt passes its own lane height/gap (9 / 5, from the frame); these are
 * the defaults the phone preview uses. `PHONE_TRACK_UNITS` is the phone
 * frame's 320-unit track, halved to the 160-unit phone track in SectionCta.
 */
export const PHONE_TRACK_UNITS = 320;

/**
 * Baseline opacity for a closed row in the *phone preview* (S7 `Phone Preview`).
 *
 * The phone keeps the older idiom — the actual bar recolours to green and the
 * blue baseline behind it drops to 35%. The pinned sequence draws a closed row
 * differently (see SEQUENCE_CLOSED_LANE_OPACITY); the two frames genuinely
 * disagree in the pen, so they are two constants rather than one shared number
 * that would have to be wrong in one place.
 */
export const PHONE_CLOSED_BASELINE_OPACITY = 0.35;

export const TRACK_LANE_HEIGHT = 7;
/** Gap between the planned lane and the actual lane, in track units. */
export const TRACK_LANE_GAP = 3;

/** Fill for a bar in a given plan state, as a token. Shared so the server
 *  render (`PlanTrack`) and the reveal animation can never disagree. */
export const PLAN_STATE_FILL: Record<PlanState, string> = {
  baseline: 'var(--plan-baseline)',
  actual: 'var(--plan-actual)',
  closed: 'var(--plan-closed)'
};

/**
 * The pinned scroll sequence (`new-key-frames` frame of the pen, LINA-117).
 *
 * Six rows on a 480-unit track with 7-unit lanes. The pen refresh of 2026-09-02
 * replaced the old four-row `key-frames` frame wholesale; this table is the
 * replacement, read straight off `new-key-frames` (its sibling is named
 * `new-key-frames-not goodd`, and is taken at its word).
 *
 * `p` is recorded for the keyframe *boundaries* only — 0.15 / 0.40 / 0.70 /
 * 1.00, the values in the frame's own KF titles. The visible stage is derived
 * from bar state, never from `p` (see `stageFor`).
 *
 * A ROW HAS THREE PHASES, not two, and this is the substance of the refresh:
 *
 *   planned   the blue planned bar only. The orange actual bar is parked in a
 *             second lane below at opacity ~0 — nothing has been reported yet.
 *   revealed  the actual bar joins the planned bar in ONE lane, laid end to end
 *             immediately after it: "this is what the plan said, this is what
 *             it took". Both bars at full strength.
 *   closed    the same end-to-end pair, the whole lane dropped to 45%, with a
 *             green check set just past the bar end.
 *
 * Note what does NOT happen any more: a closed bar is not recoloured green. The
 * blue stays blue and the orange stays orange, because the record of what was
 * agreed and what it actually took is the thing being preserved. Green is now
 * carried only by the check mark and the final HUD.
 */
export const SEQUENCE_LANE_HEIGHT = 7;
/** Gap between the planned lane and the parked actual lane (pen: AL at y = 11). */
export const SEQUENCE_LANE_GAP = 4;

/**
 * The pen's nominal track is 480 units, but a closed row deliberately runs past
 * it: planned + actual laid end to end plus the check reaches 531 on Finishes,
 * which is exactly the room between the row's name column and the HUD. The
 * viewBox is therefore the true extent, so nothing the pen drew gets clipped.
 */
export const SEQUENCE_TRACK_UNITS = 531;

/** Gap between the end of the actual bar and the check mark (pen: ~10 units). */
export const SEQUENCE_CHECK_GAP = 10;
/** Side of the square `badge-check` glyph, in track units (pen: 12 × 12 at y −2). */
export const SEQUENCE_CHECK_SIZE = 12;

/** Opacity of a closed row's whole lane — both bars (pen: `PL` at 0.45). */
export const SEQUENCE_CLOSED_LANE_OPACITY = 0.45;

export type SequenceRowKey =
  | 'foundations'
  | 'structure'
  | 'envelope'
  | 'windows'
  | 'mep'
  | 'finishes';

export const SEQUENCE_ROW_KEYS: readonly SequenceRowKey[] = [
  'foundations',
  'structure',
  'envelope',
  'windows',
  'mep',
  'finishes'
];

export type SequenceRowPhase = 'planned' | 'revealed' | 'closed';

/**
 * Per-row bar geometry, in the pen's 480-unit track.
 *
 * `plannedOffset` / `plannedWidth` are the blue bar. `actualWidth` is the orange
 * bar; `parkedOffset` is where it sits while the row is still only a plan, which
 * is the only phase in which it has an offset of its own — once revealed it is
 * drawn immediately after the planned bar, by construction.
 */
export type SequenceRowGeometry = {
  plannedOffset: number;
  plannedWidth: number;
  parkedOffset: number;
  actualWidth: number;
};

export const SEQUENCE_ROW_GEOMETRY: Record<SequenceRowKey, SequenceRowGeometry> = {
  foundations: { plannedOffset: 0, plannedWidth: 50, parkedOffset: 0, actualWidth: 60 },
  structure: { plannedOffset: 50, plannedWidth: 90, parkedOffset: 50, actualWidth: 90 },
  envelope: { plannedOffset: 150, plannedWidth: 70, parkedOffset: 165, actualWidth: 40 },
  windows: { plannedOffset: 230, plannedWidth: 55, parkedOffset: 230, actualWidth: 40 },
  mep: { plannedOffset: 260, plannedWidth: 90, parkedOffset: 260, actualWidth: 80 },
  finishes: { plannedOffset: 360, plannedWidth: 120, parkedOffset: 365, actualWidth: 110 }
};

export type SequenceHudCost = { label: 'budget' | 'spent' | 'final'; value: number };

export type SequenceKeyframe = {
  id: 'A' | 'B' | 'C' | 'D';
  p: number;
  stage: 1 | 2 | 3 | 4;
  phases: Record<SequenceRowKey, SequenceRowPhase>;
  /**
   * Rows whose planned bar sits somewhere other than `SEQUENCE_ROW_GEOMETRY` at
   * this keyframe. Only Finishes uses this, and only at KF D: appending its
   * 110-unit actual bar to a planned bar starting at 360 would push the row into
   * the HUD, so the pen slides the pair back to 279 — 279 + 120 + 110 = 509, the
   * exact width available. Encoded rather than derived because it is a layout
   * decision the designer made, not a rule the other five rows follow.
   */
  plannedOffsets?: Partial<Record<SequenceRowKey, number>>;
  hud: { cost: SequenceHudCost; tone: 'cream' | 'closed' };
};

/**
 * Cumulative spend at the two mid-sequence keyframes.
 *
 * These are readings of the build's progress, not slices of the contract, so
 * they are their own figures rather than sums of WORK_PACKAGE_ROWS. Both sit
 * below CONTRACT_TOTAL, which the sequence only reaches at KF D.
 */
export const SEQUENCE_SPENT_AT_B = 41_200;
export const SEQUENCE_SPENT_AT_C = 72_600;

/**
 * The KF A–D table, straight off `new-key-frames`.
 *
 * Read the phase columns downward and the story is the whole argument of the
 * section: Foundations and Structure close first (KF B), Envelope follows
 * (KF C) while Windows and M&E report their actuals, and Finishes stays a plan
 * until the very end.
 */
export const SEQUENCE_KEYFRAMES: readonly SequenceKeyframe[] = [
  {
    id: 'A',
    p: 0.15,
    stage: 1,
    phases: {
      foundations: 'planned',
      structure: 'planned',
      envelope: 'planned',
      windows: 'planned',
      mep: 'planned',
      finishes: 'planned'
    },
    hud: { cost: { label: 'budget', value: CONTRACT_TOTAL }, tone: 'cream' }
  },
  {
    id: 'B',
    p: 0.4,
    stage: 2,
    phases: {
      foundations: 'closed',
      structure: 'closed',
      envelope: 'revealed',
      windows: 'planned',
      mep: 'planned',
      finishes: 'planned'
    },
    hud: { cost: { label: 'spent', value: SEQUENCE_SPENT_AT_B }, tone: 'cream' }
  },
  {
    id: 'C',
    p: 0.7,
    stage: 3,
    phases: {
      foundations: 'closed',
      structure: 'closed',
      envelope: 'closed',
      windows: 'revealed',
      mep: 'revealed',
      finishes: 'planned'
    },
    hud: { cost: { label: 'spent', value: SEQUENCE_SPENT_AT_C }, tone: 'cream' }
  },
  {
    id: 'D',
    p: 1,
    stage: 4,
    phases: {
      foundations: 'closed',
      structure: 'closed',
      envelope: 'closed',
      windows: 'closed',
      mep: 'closed',
      finishes: 'closed'
    },
    plannedOffsets: { finishes: 279 },
    hud: { cost: { label: 'final', value: CONTRACT_TOTAL }, tone: 'closed' }
  }
];

/** The keyframe the server renders. Per the technical plan: the default HTML *is* p=1. */
export const SEQUENCE_FINAL_KEYFRAME = SEQUENCE_KEYFRAMES[SEQUENCE_KEYFRAMES.length - 1];

export type SequenceHudKey = SequenceKeyframe['id'];

export function formatSequenceHudCost(key: SequenceHudKey, locale: string): string {
  const kf = SEQUENCE_KEYFRAMES.find((k) => k.id === key);
  return formatEur(kf ? kf.hud.cost.value : CONTRACT_TOTAL, locale);
}

/** The four stage stills, in order. Served from /images as AVIF → WebP → PNG. */
export const SEQUENCE_STAGES = [
  { stage: 1, slug: 'stage-1-design' },
  { stage: 2, slug: 'stage-2-structure' },
  { stage: 3, slug: 'stage-3-finishing' },
  { stage: 4, slug: 'stage-4-house-built' }
] as const;

/**
 * Native pixel size of the stage sources. Do not upscale past this: the cap is
 * 1400w for both the 1402w natively and the AVIF/WebP descriptors (plan D2).
 */
export const SEQUENCE_IMAGE_WIDTH = 1402;
export const SEQUENCE_IMAGE_HEIGHT = 1122;

export const PHONE_PREVIEW = {
  buildName: 'Casa do Vale',
  week: 14,
  totalWeeks: 32
} as const;

/**
 * Euro formatting. One helper so every figure on the page is spaced and
 * grouped identically in a given locale. The design frames show `€ 97,100`;
 * pt-PT and es-ES group differently, and localising is correct — what must not
 * vary is the *value*, which is why it comes from the constants above.
 */
export function formatEur(value: number, locale: string): string {
  return `€ ${new Intl.NumberFormat(locale).format(value)}`;
}

/** Signed euro delta, e.g. "+ € 3,200" / "− € 2,592". */
export function formatEurDelta(value: number, locale: string): string {
  const sign = value < 0 ? '−' : '+';
  return `${sign} ${formatEur(Math.abs(value), locale)}`;
}

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}
