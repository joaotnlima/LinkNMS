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
 * The scroll reel (S3, `landing-page` frame).
 *
 * Four stage cards, each pinned to a `p` on the same 0→1 progress the gantt
 * tracks: 0.15 / 0.40 / 0.72 / 1.00 are the exact chip values from the pen.
 * The image slug and the progress live together here so a card can never
 * show an image and a progress that do not belong to the same stage.
 */
export const SCROLL_REEL_STAGES: readonly { stage: number; slug: string; p: number }[] = [
  { stage: 1, slug: 'stage-1-design', p: 0.15 },
  { stage: 2, slug: 'stage-2-structure', p: 0.4 },
  { stage: 3, slug: 'stage-3-finishing', p: 0.72 },
  { stage: 4, slug: 'stage-4-house-built', p: 1 }
] as const;

/**
 * Bar-lane geometry shared by every PlanTrack on the page.
 *
 * The gantt passes its own lane height/gap (9 / 5, from the frame); these are
 * the defaults the phone preview uses. `PHONE_TRACK_UNITS` is the phone
 * frame's 320-unit track, halved to the 160-unit phone track in SectionCta.
 */
export const PHONE_TRACK_UNITS = 320;
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
 * The pinned scroll sequence (`key-frames` frame of the pen, LINA-110).
 *
 * Four rows on a 320-unit track with 7-unit lanes, planned above actual. The
 * geometry per keyframe is the KF A–D table from the pen, wired literally so
 * the animation reads the table rather than eyeballing timings. `p` is recorded
 * here for the keyframe *boundaries* only (0.15 / 0.40 / 0.70 / 1.00 — these
 * are the sequence's own numbers, NOT the inline reel's 0.72) — the visible
 * stage is derived from bar state, never from `p`.
 */
export const SEQUENCE_TRACK_UNITS = 320;
export const SEQUENCE_LANE_HEIGHT = 7;
/** Gap between the planned lane and the actual lane, in track units. */
export const SEQUENCE_LANE_GAP = 3;

export type SequenceRowKey = 'foundations' | 'structure' | 'envelope' | 'finishes';

export const SEQUENCE_ROW_KEYS: readonly SequenceRowKey[] = [
  'foundations',
  'structure',
  'envelope',
  'finishes'
];

/** Planned (baseline) lane geometry. Fixed for the whole sequence — the baseline never moves. */
export const SEQUENCE_PLANNED: Record<SequenceRowKey, { offset: number; width: number }> = {
  foundations: { offset: 0, width: 60 },
  structure: { offset: 60, width: 80 },
  envelope: { offset: 140, width: 80 },
  finishes: { offset: 220, width: 100 }
};

export type SequenceKeyframe = {
  id: 'A' | 'B' | 'C' | 'D';
  p: number;
  stage: 1 | 2 | 3 | 4;
  rows: Record<SequenceRowKey, { offset: number; width: number; state: PlanState }>;
  hud: { tone: PlanState };
};

/** The KF A–D table, straight off the pen's `key-frames` frame (e.g. KF B at
 *  p=0.40: Foundations + Structure green, the rest still blue). */
export const SEQUENCE_KEYFRAMES: readonly SequenceKeyframe[] = [
  {
    id: 'A',
    p: 0.15,
    stage: 1,
    rows: {
      foundations: { offset: 0, width: 60, state: 'actual' },
      structure: { offset: 60, width: 100, state: 'actual' },
      envelope: { offset: 160, width: 80, state: 'actual' },
      finishes: { offset: 240, width: 80, state: 'actual' }
    },
    hud: { tone: 'baseline' }
  },
  {
    id: 'B',
    p: 0.4,
    stage: 2,
    rows: {
      foundations: { offset: 0, width: 60, state: 'closed' },
      structure: { offset: 60, width: 80, state: 'closed' },
      envelope: { offset: 160, width: 80, state: 'actual' },
      finishes: { offset: 240, width: 80, state: 'actual' }
    },
    hud: { tone: 'baseline' }
  },
  {
    id: 'C',
    p: 0.7,
    stage: 3,
    rows: {
      foundations: { offset: 0, width: 60, state: 'closed' },
      structure: { offset: 60, width: 80, state: 'closed' },
      envelope: { offset: 140, width: 80, state: 'closed' },
      finishes: { offset: 240, width: 80, state: 'actual' }
    },
    hud: { tone: 'actual' }
  },
  {
    id: 'D',
    p: 1,
    stage: 4,
    rows: {
      foundations: { offset: 0, width: 60, state: 'closed' },
      structure: { offset: 60, width: 80, state: 'closed' },
      envelope: { offset: 140, width: 80, state: 'closed' },
      finishes: { offset: 220, width: 100, state: 'closed' }
    },
    hud: { tone: 'closed' }
  }
];

/** The keyframe the server renders. Per the technical plan: the default HTML *is* p=1. */
export const SEQUENCE_FINAL_KEYFRAME = SEQUENCE_KEYFRAMES[SEQUENCE_KEYFRAMES.length - 1];

/** Baseline lane opacity once every row has closed (KF D: "blue baseline at 35%"). */
export const SEQUENCE_CLOSED_BASELINE_OPACITY = 0.35;

/**
 * HUD cost reading per keyframe, straight off the KF A–D table.
 *
 * B and D read the flat contract total; C carries the signed materials movement
 * ("+ € 3,200") that is the slip in progress. Charged to one record here so the
 * three keyframes can never disagree with CONTRACT_TOTAL / MATERIALS_DELTA_SINCE_MARCH.
 */
export type SequenceHudKey = 'B' | 'C' | 'D';

export const SEQUENCE_HUD_COST: Record<SequenceHudKey, { value?: number; delta?: number }> = {
  B: { value: CONTRACT_TOTAL },
  C: { delta: MATERIALS_DELTA_SINCE_MARCH },
  D: { value: CONTRACT_TOTAL }
};

export function formatSequenceHudCost(key: SequenceHudKey, locale: string): string {
  const entry = SEQUENCE_HUD_COST[key];
  if (entry.delta != null) return formatEurDelta(entry.delta, locale);
  return formatEur(entry.value ?? CONTRACT_TOTAL, locale);
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
