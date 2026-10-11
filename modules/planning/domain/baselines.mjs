// Baselines as the plan header lists and compares them (PRD-10 E-1; D-24: a
// baseline is a label on a branch, D-43: taken at award). Pure.

/**
 * Wire Baseline rows, newest first, `is_current` on the latest version of each
 * branch (contract). `rows` are store rows (snake_case) with root ids and names.
 */
export function baselineList(rows, orgNames) {
  const latest = new Map();
  for (const b of rows) {
    if (!latest.has(b.contract_id) || b.version > latest.get(b.contract_id)) latest.set(b.contract_id, b.version);
  }
  return [...rows]
    .sort((a, b) => String(b.taken_at_iso).localeCompare(String(a.taken_at_iso)) || b.version - a.version)
    .map((b) => ({
      id: b.id,
      contract_id: b.contract_id,
      version: b.version,
      reason: b.reason,
      ...(b.change_order_id ? { change_order_id: b.change_order_id } : {}),
      root_task_ids: b.root_task_ids ?? [],
      ...(b.root_names?.length ? { branch_name: b.root_names.join(' · ') } : {}),
      row_count: b.row_count ?? 0,
      is_current: latest.get(b.contract_id) === b.version,
      ...(b.taken_by_org_id || b.taken_by_person_id
        ? { taken_by: { person_id: b.taken_by_person_id ?? undefined, org_id: b.taken_by_org_id ?? undefined } }
        : {}),
      ...(b.taken_by_org_id && orgNames?.get(b.taken_by_org_id) ? { taken_by_org_name: orgNames.get(b.taken_by_org_id) } : {}),
      taken_at: b.taken_at_iso,
    }));
}

/**
 * The plan drawn against a chosen baseline: the rows its snapshot holds take
 * their baseline span from it (and `comparedMeta`, the version that labels
 * them); every other row keeps its own. Returns a NEW task map — the snapshot
 * is never mutated.
 * Rows of the snapshot that sit outside the chosen version's branch today keep
 * the snapshot's dates too — the comparison is "that baseline vs now".
 */
export function rebaseOn(tasks, chosen) {
  const byTask = new Map(chosen.rows.map((r) => [r.task_id, r]));
  const out = new Map();
  for (const [id, t] of tasks) {
    const snap = byTask.get(id);
    out.set(id, snap
      ? {
          ...t,
          baselineStart: snap.start ?? null,
          baselineFinish: snap.finish ?? null,
          baselineVersion: chosen.version,
          comparedMeta: { version: chosen.version, reason: chosen.reason, takenAt: chosen.taken_at_iso },
        }
      : t);
  }
  return out;
}
