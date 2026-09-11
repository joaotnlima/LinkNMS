// The plan grid's COLUMN MODEL (LINA-261 behaviours 4 and 6).
//
// The grid's left pane used to be a hard-coded CSS `grid-template-columns`
// string, which meant the column set was a fact of the stylesheet and could not
// be reordered. Here it becomes DATA: an ordered array of column ids the grid
// renders header and cells from, and from which the template string is built.
// PlanGrid stays presentational — every decision about what may move where, and
// how wide a column may get, is a pure function in this file with a unit test.
//
// WHAT IS AND IS NOT ORDERABLE
// The row's leading grip and trailing action buttons are chrome, not columns —
// they are the handle you drag the ROW by and the buttons that add/remove it, so
// they are fixed at the two ends and never enter the order. The WBS id ('1.2')
// is likewise pinned: it is the row's address, and an address that wanders is
// not one. Of the remaining data columns, TASK is pinned at index 0 (the founder
// requirement — the thing being named never moves) and the rest reorder freely.

/** A reorderable data column of the plan grid's table pane. */
export type ColumnId = 'name' | 'trade' | 'owner' | 'status' | 'dates';

export interface ColumnSpec {
  /** The header's visible text. */
  label: string;
  /** Narrower than this and the cell's content breaks; the resize floor. */
  min: number;
  /** Track sizing when the author has not resized this column. */
  basis: string;
  /** Pinned columns cannot be dragged, and nothing may be dropped before them. */
  pinned?: true;
  /** Whether the header carries a drag-to-resize / double-click-to-fit strip. */
  resizable?: true;
  /**
   * Breathing room added to the widest measured cell when fitting to content.
   * It is per-column because a column's chrome is: the Task cell carries a
   * rename button, the Dates cell two native date pickers whose widget is much
   * wider than the text inside it.
   */
  fitPad: number;
}

export const COLUMN_SPECS: Record<ColumnId, ColumnSpec> = {
  // Task is the subject of the row: pinned first, and the flexible track that
  // yields whatever width the others do not take.
  name: { label: 'Task', min: 120, basis: 'minmax(120px, 1fr)', pinned: true, resizable: true, fitPad: 40 },
  trade: { label: 'Specialty', min: 56, basis: '96px', resizable: true, fitPad: 20 },
  owner: { label: 'Owner', min: 30, basis: '30px', fitPad: 12 },
  status: { label: 'Status', min: 76, basis: '96px', fitPad: 20 },
  dates: { label: 'Dates', min: 150, basis: '176px', resizable: true, fitPad: 56 },
};

/** The order the grid opens in — the layout that shipped with LINA-248. */
export const DEFAULT_COLUMN_ORDER: ColumnId[] = ['name', 'trade', 'owner', 'status', 'dates'];

/** Fixed chrome either side of the ordered columns: the row grip, the WBS id… */
const LEAD_TRACKS = '20px 34px';
/** …and the add/remove buttons. */
const TRAIL_TRACKS = '92px';

/** The widest a column may be dragged or fitted to — past this it crowds the rest. */
export const COL_MAX = 560;

/**
 * Move a column to a new index, honouring the pins.
 *
 * Returns the SAME array reference when the move is refused or is a no-op, so a
 * caller can treat identity as "nothing happened" and skip the state update:
 *   • a pinned column (Task) never moves;
 *   • nothing may be dropped at index 0, because Task lives there.
 */
export function moveColumn(order: ColumnId[], from: number, to: number): ColumnId[] {
  if (from === to) return order;
  const moving = order[from];
  if (moving === undefined || order[to] === undefined) return order;
  if (COLUMN_SPECS[moving].pinned) return order;
  if (to === 0) return order; // index 0 belongs to the pinned Task column
  const next = order.slice();
  next.splice(from, 1);
  next.splice(to, 0, moving);
  return next;
}

/**
 * The `grid-template-columns` value for one order + the author's resize widths.
 * A column the author has sized gets that exact px track; the rest fall back to
 * their spec basis, so an untouched grid renders precisely as it always did.
 */
export function columnTemplate(
  order: ColumnId[], widths: Partial<Record<ColumnId, number>>,
): string {
  const tracks = order.map((id) => {
    const w = widths[id];
    return w ? `${w}px` : COLUMN_SPECS[id].basis;
  });
  return `${LEAD_TRACKS} ${tracks.join(' ')} ${TRAIL_TRACKS}`;
}

/**
 * The width that FITS a column's content (behaviour 4: double-click the resize
 * strip). Takes the measured pixel width of every rendered cell in the column —
 * measuring is the caller's job, since it needs a DOM; choosing the width is
 * this function's, since that is the part worth testing.
 *
 * The widest cell plus breathing room, clamped to the column's own floor and the
 * shared ceiling. An empty column collapses to its floor rather than to nothing.
 */
export function fitColumnWidth(
  id: ColumnId, textWidths: number[], padding = COLUMN_SPECS[id].fitPad,
): number {
  const widest = textWidths.length > 0 ? Math.max(...textWidths) : 0;
  const wanted = Math.ceil(widest + padding);
  return Math.min(COL_MAX, Math.max(COLUMN_SPECS[id].min, wanted));
}

/**
 * Clamp a width the author is DRAGGING to. Same bounds as the fit, so a column
 * cannot be dragged below a size double-clicking would have rescued it from.
 */
export function clampColumnWidth(id: ColumnId, width: number): number {
  return Math.min(COL_MAX, Math.max(COLUMN_SPECS[id].min, Math.round(width)));
}

// ── The table / timeline split (LINA-261 behaviour 2) ────────────────────────
// The divider between the editable table and the Gantt canvas is draggable. The
// table's width is component state in px; the timeline takes the rest. Both
// panes keep a floor so neither can be dragged out of existence — the table has
// to stay wide enough to read a task name, the timeline wide enough to show a
// bar in context.

export const SPLIT = { tableMin: 360, timelineMin: 240, default: 560 } as const;

/**
 * The table pane's width for a drag, given the grid's total width. Clamped so
 * the table keeps `tableMin` and the timeline keeps `timelineMin`; when the
 * viewport is too narrow to honour both, the table floor wins (you can always
 * scroll the timeline, but an unreadable table has nothing to scroll to).
 */
export function clampSplit(width: number, total: number): number {
  const ceiling = Math.max(SPLIT.tableMin, total - SPLIT.timelineMin);
  return Math.round(Math.min(ceiling, Math.max(SPLIT.tableMin, width)));
}
