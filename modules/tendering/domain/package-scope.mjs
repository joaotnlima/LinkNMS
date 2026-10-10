// The package's scope — pure (no I/O), PRD-02 T-3.
//
// A tender covers its roots' SUB-TREES (doc 05 §10). Some descendants may be
// LEFT OUT — typically a row already assigned to another party ("2.5.3 Gutters
// — already assigned to Nuno Ferreira"). Planning says which rows and why
// (getTenderWindow); the issuer's choice is recorded on the RFP as
// `excluded_task_ids`, and the package snapshot is pruned here: an excluded row
// goes with its own sub-tree, and so do its BoQ items.

/**
 * Validate the requested exclusions against the snapshot of the roots'
 * sub-trees. Returns an error string or null.
 *
 * @param rows        snapshot rows ({task_id, parent_task_id}); roots carry a
 *                    null parent_task_id
 * @param excludedIds the issuer's exclusions (already de-duplicated)
 */
export function exclusionError(rows, excludedIds) {
  const inPackage = new Map(rows.map((r) => [r.task_id, r]));
  for (const id of excludedIds) {
    const row = inPackage.get(id);
    if (!row) return `not inside the tendered sub-trees: ${id}`;
    if (!row.parent_task_id) return `a tendered root cannot be left out: ${id}`;
  }
  return null;
}

/**
 * The snapshot minus the excluded rows, their descendants and their BoQ items.
 * Order is preserved (the store hands rows in depth, position order).
 */
export function prunePackage({ rows, items }, excludedIds) {
  const excluded = new Set(excludedIds ?? []);
  if (excluded.size === 0) return { rows, items };
  const parentOf = new Map(rows.map((r) => [r.task_id, r.parent_task_id ?? null]));
  const dropped = new Set();
  const isDropped = (id) => {
    for (let cur = id; cur; cur = parentOf.get(cur) ?? null) {
      if (excluded.has(cur) || dropped.has(cur)) return true;
    }
    return false;
  };
  for (const r of rows) if (isDropped(r.task_id)) dropped.add(r.task_id);
  return {
    rows: rows.filter((r) => !dropped.has(r.task_id)),
    items: items.filter((i) => !dropped.has(i.task_id)),
  };
}
