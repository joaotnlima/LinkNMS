// Rekey freshly-created plan rows from author-local keys to their stable v2 ids
// (LINA-369, S3b — the editor rewire's crux).
//
// A v2 write returns `idByKey`: for every row the save CREATED, its author-local
// key (`t-5`, `s-2`, …) → the row UUID the server minted. The autosave editor
// diffs the last-saved tree against the next one BY KEY (a row in both is an
// existing row to PATCH; a row only in `next` is a create; a row only in `prev`
// is a delete — see `plan-diff.ts`). So the moment a save lands, the editor must
// adopt the minted ids as those rows' keys — in the LIVE draft tree it edits AND
// in the last-saved wire tree it will diff the next save against. Skip it and the
// next diff targets a dead local key: at best a PATCH/link 404s the row the
// server never stored under that key, at worst the diff treats every created row
// as still-to-create and the persisted row as to-delete — a phantom rewrite of a
// tree the author never touched, on the audit surface that is the product.
//
// Two shapes, one rule. A `PhaseDraft` tree carries its edges as `dependsOn: {on,
// type}`; the wire `AuthoredNode` tree carries them as `dependsOn: {key, type}`.
// Both remap a key (or an edge's reference) IFF `idByKey` holds it, and leave
// every other key untouched — rows added since the save (still local, not in the
// map) and existing rows already on their v2 id (never in the map) both pass
// through unchanged. Pure; unit-tested under node --test.
import type { AuthoredNode, DepEdge, PhaseDraft, TaskDraft } from '@/lib/plan-authoring';

/** author-local key → the stable v2 row id the save minted for a created row. */
export type IdByKey = Record<string, string>;

const remap = (key: string, idByKey: IdByKey): string => idByKey[key] ?? key;

/**
 * Rekey a live `PhaseDraft` tree by `idByKey`: every node's `key`, and every
 * `dependsOn[].on` that points at a remapped node, adopts the minted v2 id. A
 * fresh copy — the editor swaps it into React state, so it must not share nodes
 * with the tree it replaces.
 */
export function rekeyDraft(phases: PhaseDraft[], idByKey: IdByKey): PhaseDraft[] {
  const edges = (deps: DepEdge[]): DepEdge[] =>
    deps.map((d) => (idByKey[d.on] ? { ...d, on: idByKey[d.on] } : d));
  const task = (t: TaskDraft): TaskDraft => ({
    ...t,
    key: remap(t.key, idByKey),
    dependsOn: edges(t.dependsOn),
    children: (t.children ?? []).map(task),
  });
  return phases.map((p) => ({
    ...p,
    key: remap(p.key, idByKey),
    dependsOn: edges(p.dependsOn),
    tasks: p.tasks.map(task),
  }));
}

/**
 * Rekey a wire `AuthoredNode` tree by `idByKey` — the last-saved snapshot the next
 * diff runs against. Same rule as `rekeyDraft`, but the edge reference is `key`
 * (the wire form), not `on`.
 */
export function rekeyWire(nodes: AuthoredNode[], idByKey: IdByKey): AuthoredNode[] {
  const node = (n: AuthoredNode): AuthoredNode => ({
    ...n,
    key: remap(n.key, idByKey),
    dependsOn: n.dependsOn.map((d) => (idByKey[d.key] ? { ...d, key: idByKey[d.key] } : d)),
    ...(n.children ? { children: n.children.map(node) } : {}),
  });
  return nodes.map(node);
}

/**
 * Every node key in a draft tree, in document order — what the editor sets its
 * `savedKeys` to after a save (every row now lives on the server, so its
 * workspace is addressable). Read AFTER a rekey, so the keys are the v2 ids.
 */
export function draftKeys(phases: PhaseDraft[]): string[] {
  const out: string[] = [];
  for (const p of phases) {
    out.push(p.key);
    for (const t of p.tasks) {
      out.push(t.key);
      for (const s of t.children ?? []) out.push(s.key);
    }
  }
  return out;
}
