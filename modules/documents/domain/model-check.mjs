// The model upload check (PRD-07 M-18) — pure. Links and issues are keyed by
// element GlobalId, so they carry over to a new .ifc by themselves; what the
// author must SEE is (1) the recorded elements the new file no longer has
// (listed for relinking — the record keeps them, nothing is dropped) and
// (2) an export that regenerated its GlobalIds ("all removed, all added"),
// which would orphan everything.

const GLOBAL_ID = /^[0-9A-Za-z_$]{22}$/;
/** Elements one declared list may carry (a large model has ~10^5). */
export const MAX_DECLARED_GLOBAL_IDS = 500000;
/** "Regenerated": the files share fewer than this share of elements… */
export const REGENERATED_SHARE = 0.1;
/** …and both have at least this many (tiny files say nothing). */
export const REGENERATED_MIN_ELEMENTS = 5;

/** Validate the client-declared GlobalIds of a model version. */
export function validateDeclaredGlobalIds(raw) {
  if (raw === undefined || raw === null) return { globalIds: null };
  if (!Array.isArray(raw) || raw.length > MAX_DECLARED_GLOBAL_IDS) {
    return { error: `an array of at most ${MAX_DECLARED_GLOBAL_IDS} IFC GlobalIds` };
  }
  if (raw.some((g) => typeof g !== 'string' || !GLOBAL_ID.test(g))) return { error: 'IFC GlobalIds (22 characters each)' };
  return { globalIds: [...new Set(raw)].sort() };
}

/**
 * @param {Iterable<string>} recorded  GlobalIds on the record (live links + open-or-closed pins)
 * @param {Iterable<string>} next      GlobalIds of the new file
 * @param {Iterable<string>|null} previous GlobalIds of the previous upload, or null
 */
export function modelUploadCheck({ recorded, next, previous = null }) {
  const nextSet = new Set(next);
  const rec = new Set(recorded);
  const unmatched = [...rec].filter((g) => !nextSet.has(g)).sort();
  let shared = 0;
  let regenerated = false;
  if (previous) {
    const prev = new Set(previous);
    for (const g of prev) if (nextSet.has(g)) shared += 1;
    const base = Math.min(prev.size, nextSet.size);
    regenerated = base >= REGENERATED_MIN_ELEMENTS && shared / base < REGENERATED_SHARE;
  }
  return { unmatched, regenerated, shared, recorded: rec.size };
}

/** The check on the wire (#/components/schemas/ModelUploadCheck). */
export function uploadCheckBody(row) {
  return {
    version_no: row.version_no,
    element_count: row.global_ids?.length ?? 0,
    unmatched_global_ids: row.unmatched_global_ids ?? [],
    regenerated: Boolean(row.regenerated),
    shared_count: row.shared_count ?? 0,
    recorded_count: row.recorded_count ?? 0,
  };
}
