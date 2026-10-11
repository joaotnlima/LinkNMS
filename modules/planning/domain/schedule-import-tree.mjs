// Excel plan import — the WBS the parsed rows become, their dependencies and
// the rows + links to write (PRD-09 O-8, O-9; flows/01). Pure.
//
// Two levels, as the Excel contract states: an Action groups its Sub-actions.
// A row with an Action and no Sub-action IS that action (its own dates, trade
// and dependency); when the action also has sub-actions it becomes a summary
// and its dates derive from them (D-25), so its own dates are not written.
//
// Dependency tokens: `R{n}` (a row of the same sheet, as the published
// template writes them) or the name of an action / sub-action. Unknown, self
// and cycle-closing references are warnings, and the link is dropped — never a
// blocked import. Each link is end → start with the lag the file's own dates
// imply, so the imported dates stand as written (a link stores the gap, D-22).
import { makeCalendar, spanFinish } from './calendar.mjs';
import { cyclePath, lagFor } from './propagation.mjs';
import { normalise } from './schedule-import.mjs';

/**
 * @param {Array} rows   parseRows(...).rows
 * @param {{ calendar?: object }} [opts] raw project calendar (for duration → finish)
 * @returns {{ tree: Array, links: Array<{from, to, lag_wd}>, warnings: Array, counts: object }}
 */
export function buildTree(rows, { calendar = {} } = {}) {
  const cal = makeCalendar(calendar);
  const actions = new Map(); // normalised name → node
  const byRow = new Map(); // sheet row → node
  const order = [];

  const finishOf = (r) => r.finish ?? (r.start && r.duration_wd ? spanFinish(cal, r.start, r.duration_wd) : null);

  for (const r of rows) {
    const k = normalise(r.action);
    let a = actions.get(k);
    if (!a) {
      a = { key: `a${order.length + 1}`, row: r.row, name: r.action, start: null, finish: null, trade: null, specialty_code: null, dependency: null, depends_on: [], children: [], own: false };
      actions.set(k, a);
      order.push(a);
    }
    if (!r.sub_action) {
      if (!a.own) {
        Object.assign(a, { row: r.row, start: r.start, finish: finishOf(r), trade: r.trade, specialty_code: r.specialty_code, dependency: r.dependency, own: true });
      }
      byRow.set(r.row, a);
      continue;
    }
    const child = {
      key: `${a.key}.${a.children.length + 1}`, row: r.row, name: r.sub_action, start: r.start, finish: finishOf(r),
      trade: r.trade ?? a.trade, specialty_code: r.specialty_code ?? a.specialty_code, dependency: r.dependency, depends_on: [], parent: a,
    };
    a.children.push(child);
    byRow.set(r.row, child);
  }

  // A summary's dates are its children's span (what the plan will show).
  for (const a of order) {
    if (!a.children.length) continue;
    const starts = a.children.map((c) => c.start).filter(Boolean).sort();
    const finishes = a.children.map((c) => c.finish ?? c.start).filter(Boolean).sort();
    a.start = starts[0] ?? null;
    a.finish = finishes.at(-1) ?? null;
  }

  const { links, warnings } = resolveDependencies(order, byRow, cal);
  for (const l of links) l.to.depends_on.push(l.from.key);
  return {
    tree: order.map(nodeBody),
    links: links.map((l) => ({ from: l.from.key, to: l.to.key, lag_wd: l.lag_wd })),
    warnings,
    counts: {
      rows: rows.length,
      actions: order.length,
      sub_actions: order.reduce((n, a) => n + a.children.length, 0),
      links: links.length,
      trades: new Set(rows.map((r) => r.specialty_code ?? normalise(r.trade)).filter(Boolean)).size,
    },
  };
}

function nodeBody(n) {
  return {
    key: n.key, row: n.row, name: n.name, start: n.start ?? null, finish: n.finish ?? null,
    trade: n.trade ?? null, specialty_code: n.specialty_code ?? null, depends_on: n.depends_on,
    ...(n.children ? { children: n.children.map(nodeBody) } : {}),
  };
}

function resolveDependencies(order, byRow, cal) {
  const all = order.flatMap((a) => [a, ...a.children]);
  const byName = new Map();
  for (const n of all) {
    const k = normalise(n.name);
    byName.set(k, [...(byName.get(k) ?? []), n]);
  }
  const ancestorOf = (x, y) => y.parent === x; // two levels only
  const links = [];
  const warnings = [];
  const edges = [];

  // Sheet order: the earlier row's link wins when two would close a loop.
  for (const node of [...all].sort((x, y) => x.row - y.row)) {
    if (!node.dependency) continue;
    for (const token of String(node.dependency).split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean)) {
      const pred = lookup(token, node, byRow, byName);
      if (!pred) {
        warnings.push({ row: node.row, field: 'dependency', code: 'unknown_dependency', message: `Row ${node.row} (“${node.name}”) depends on “${token}”, which isn't an action in this file — the link was left out.` });
        continue;
      }
      if (pred === node) {
        warnings.push({ row: node.row, field: 'dependency', code: 'self_dependency', message: `Row ${node.row} (“${node.name}”) depends on itself — the link was left out.` });
        continue;
      }
      const dup = links.some((l) => l.from === pred && l.to === node);
      // Cycles are checked between LEAVES: a summary stands for its children,
      // so "B after A" plus "A's child after B" is a loop even though no two
      // links name the same rows.
      const pairs = leavesOf(pred).flatMap((p) => leavesOf(node).map((s) => ({ predecessorId: p.key, successorId: s.key })));
      if (dup || ancestorOf(pred, node) || ancestorOf(node, pred)
          || pairs.some((c) => c.predecessorId === c.successorId || cyclePath(edges, c))) {
        if (!dup) {
          warnings.push({ row: node.row, field: 'dependency', code: 'dependency_cycle', message: `Row ${node.row} (“${node.name}”) → “${pred.name}” would close a loop — the link was left out.` });
        }
        continue;
      }
      edges.push(...pairs);
      const link = { fromAnchor: 'end', toAnchor: 'start', lagWd: 0 };
      const lag = pred.finish && node.start
        ? lagFor({ link, predSpan: { start: pred.start, finish: pred.finish }, succStart: node.start, succFinish: node.finish, calendar: cal })
        : 0;
      links.push({ from: pred, to: node, lag_wd: lag });
    }
  }
  return { links, warnings };
}

const leavesOf = (n) => (n.children?.length ? n.children : [n]);

function lookup(token, node, byRow, byName) {
  const r = /^r\s*(\d+)$/i.exec(token);
  if (r) return byRow.get(Number(r[1])) ?? null;
  const hits = byName.get(normalise(token)) ?? [];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // Same name twice: prefer the sibling under the same action, then the action itself.
    const parent = node.parent ?? node;
    return hits.find((h) => h.parent === parent) ?? hits.find((h) => !h.parent) ?? null;
  }
  return null;
}

/**
 * The structural batch the confirm writes: rows (parents first) and links.
 * @param {Array} tree   buildTree(...).tree
 * @param {Array} links  buildTree(...).links
 * @param {() => string} newId  id minting (UUIDv7 / uuid in the application)
 */
export function toCreateBatch(tree, links, newId) {
  const ids = new Map();
  const rows = [];
  const spec = (n, parentId) => {
    const id = newId();
    ids.set(n.key, id);
    const summary = (n.children?.length ?? 0) > 0;
    const dated = !summary && !!n.start;
    rows.push({
      id,
      parent_id: parentId,
      name: n.name.slice(0, 500),
      kind: 'task',
      dating_mode: dated ? 'dated' : 'undated',
      ...(dated ? { start: n.start, ...(n.finish ? { finish: n.finish } : {}) } : {}),
      ...(n.trade ? { specialty: n.trade.slice(0, 120) } : {}),
      ...(n.specialty_code ? { specialty_code: n.specialty_code } : {}),
    });
    for (const c of n.children ?? []) spec(c, id);
  };
  for (const a of tree) spec(a, null);
  return {
    rows,
    links: links.map((l) => ({
      id: newId(), predecessor_id: ids.get(l.from), successor_id: ids.get(l.to),
      from_anchor: 'end', to_anchor: 'start', lag_wd: l.lag_wd,
    })),
  };
}
