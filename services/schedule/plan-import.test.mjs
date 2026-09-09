// Service orchestration tests for the Slice B1 plan import (LINA-206; frozen
// contract docs/architecture/slice-b1-plan-import-contract.md §2–§5):
//   - authorization: counterparty/GC only, always project-scoped (ADR-0004);
//   - stateless inspect/columns/preview;
//   - :confirm = ONE transaction = ONE `plan_import` ledger event, with
//     stage ids computed in WBS pre-order so the payload_hash reproduces;
//   - idempotent confirm (serverless retry with a used key writes nothing and
//     returns the ORIGINAL result — contract §2);
//   - the client's preview is never trusted: confirm re-parses server-side and
//     refuses (400 validation_failed) a dirty tree.
//
// The in-memory doubles (ports.mjs) are wrapped so the confirm transaction truly
// rolls back store + ledger on error, mirroring the Postgres tx the pg adapter
// opens.
// Run: node --test services/schedule/plan-import.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanImportService } from './plan-import.mjs';
import { PARSER } from './plan-import-parser.mjs';
import {
  createInMemoryStore, createInMemoryLedger, createInMemoryIdentity, ACTION,
} from './ports.mjs';
import { makeWorkbook } from './plan-import-parser.test.mjs';
import { payloadHash, verifyChain, computeAppend, GENESIS_HASH } from '../ledger/hash-chain.mjs';

const PROJECT = 'proj-1';
const GC = 'gc-1';
const OWNER = 'owner-1';
const OUTSIDER = 'stranger-1';

const SHEET = 'Plan';
const PLAN = {
  Plan: [
    ['Foundation', '', '2026-01-05', '2026-02-02', 'Civil', ''],
    ['Foundation', 'Excavate', '2026-01-05', '2026-01-15', 'Civil', ''],
    ['Foundation', 'Pour footings', '2026-01-16', '2026-02-02', 'Civil', 'R3'],
    ['Framing', '', '2026-02-10', '2026-03-20', 'Carpentry', 'R2'],
    ['Framing', 'Walls', '2026-02-10', '2026-03-01', 'Carpentry', 'R3,R4'],
  ],
};
const MAPPING = { action: 1, subAction: 2, start: 3, end: 4, trade: 5, dependency: 6 };

// Wrap store + ledger so a threw transaction rolls BOTH back — the in-memory
// ledger append in the failed txn is a phantom otherwise (the pg adapter runs
// both in ONE real tx, so production rolls back the event too).
function makeHarness() {
  const store = createInMemoryStore();
  const ledger = createInMemoryLedger();
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: GC, role: 'counterparty' },
      { projectId: PROJECT, partyId: OWNER, role: 'owner' },
    ],
  });

  const snapshot = () => ({
    stages: new Map([...store._stages].map(([k, v]) => [k, { ...v }])),
    imports: store._imports.map((i) => ({ ...i })),
    deps: store._dependencies.map((d) => ({ ...d })),
    versions: store._versions.map((v) => ({ ...v })),
    acceptances: store._acceptances.map((a) => ({ ...a })),
    events: ledger._events.map((e) => ({ ...e, payload: {
      ...e.payload,
      ...(Array.isArray(e.payload.stageIds) ? { stageIds: [...e.payload.stageIds] } : {}),
    } })),
  });
  const restore = (s) => {
    store._stages.clear();
    for (const [k, v] of s.stages) store._stages.set(k, v);
    store._imports.length = 0; store._imports.push(...s.imports);
    store._dependencies.length = 0; store._dependencies.push(...s.deps);
    store._versions.length = 0; store._versions.push(...s.versions);
    store._acceptances.length = 0; store._acceptances.push(...s.acceptances);
    ledger._events.length = 0; ledger._events.push(...s.events);
  };

  const tx = store.transaction;
  store.transaction = async (fn) => {
    const snap = snapshot();
    try {
      return await tx(fn);
    } catch (e) {
      restore(snap);
      throw e;
    }
  };

  const service = createPlanImportService({ store, parser: PARSER, ledger, identity });
  return { service, store, ledger, identity };
}

test('authorization: only a counterparty (GC) may inspect/preview/confirm', async () => {
  const { service } = makeHarness();
  const buf = await makeWorkbook(PLAN);

  for (const [assertion, result] of [
    ['gc inspect', service.inspect(PROJECT, GC, { filename: 'p.xlsx', buffer: buf })],
    ['gc confirm', service.confirm(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING, idempotencyKey: 'k1' })],
  ]) {
    await assert.doesNotReject(result, assertion);
  }

  await assert.rejects(
    service.inspect(PROJECT, OWNER, { filename: 'p.xlsx', buffer: buf }),
    (e) => e.status === 403 && e.code === 'forbidden',
    'owner cannot consume plan-import routes',
  );
  await assert.rejects(
    service.confirm(PROJECT, OUTSIDER, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING, idempotencyKey: 'k2' }),
    (e) => e.status === 403 && e.code === 'forbidden',
    'a non-member sees nothing',
  );
});

test('authorization: unauthenticated (no acting party) is a 401', async () => {
  const { service } = makeHarness();
  const buf = await makeWorkbook(PLAN);
  await assert.rejects(
    service.inspect(PROJECT, undefined, { filename: 'p.xlsx', buffer: buf }),
    (e) => e.status === 401 && e.code === 'unauthenticated',
  );
});

test('columns/preview require a sheet name (invalid_sheet 400)', async () => {
  const { service } = makeHarness();
  const buf = await makeWorkbook(PLAN);
  await assert.rejects(
    service.columns(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: ' ' }),
    (e) => e.status === 400 && e.code === 'invalid_sheet',
  );
  await assert.rejects(
    service.preview(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: undefined, mapping: MAPPING }),
    (e) => e.status === 400 && e.code === 'invalid_sheet',
  );
});

test('preview: validation problems are a 200 payload, never a promise rejection', async () => {
  const { service } = makeHarness();
  const buf = await makeWorkbook({ Plan: [['Framing', '', '2026-02-10', '2026-03-20'], ['', 'Walls', '2026-02-10', '2026-03-01']] });
  const out = await service.preview(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING });
  assert.ok(out.errors.some((e) => e.includes('no action name')), JSON.stringify(out.errors));
  assert.equal(out.warnings.length, 0);
  assert.equal(out.stats.rootCount, 1);
  assert.deepEqual(Object.keys(out).sort(), ['errors', 'roots', 'stats', 'warnings']);
});

test('preview: WBS tree keeps parents-before-children refs and deps', async () => {
  const { service } = makeHarness();
  const buf = await makeWorkbook(PLAN);
  const out = await service.preview(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING });
  assert.deepEqual(out.errors, []);
  assert.equal(out.stats.stageCount, 5);
  assert.equal(out.stats.rootCount, 2);
  assert.deepEqual(out.roots.map((r) => r.ref), ['R2', 'R5']);
  assert.deepEqual(out.roots[0].children.map((c) => c.ref), ['R3', 'R4']);
  assert.deepEqual(out.roots[1].dependsOn, ['R2']);
  assert.deepEqual(out.roots[1].children[0].dependsOn, ['R3', 'R4']);
});

test('confirm: one transaction writes header + version + stages + deps + plan_import + plan_proposed', async () => {
  const { service, store, ledger } = makeHarness();
  const buf = await makeWorkbook(PLAN);
  const before = ledger._events.length;
  const res = await service.confirm(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING, idempotencyKey: 'idem-1' });

  assert.equal(res.stageCount, 5);
  assert.equal(res.rootCount, 2);

  // The import audit event + the import-seed plan_proposed (B2 contract §4).
  const planEvents = ledger._events.slice(before);
  assert.equal(planEvents.length, 2);
  const ev = planEvents[0];
  assert.equal(ev.type, 'plan_import');
  assert.equal(ev.projectId, PROJECT);
  assert.equal(ev.actorPartyId, GC);
  assert.deepEqual(Object.keys(ev.payload).sort(),
    ['columnMapping', 'filename', 'importId', 'rootCount', 'sheetName', 'stageCount', 'stageIds']);
  assert.equal(ev.payload.importId, res.importId);
  assert.equal(ev.payload.sheetName, SHEET);
  assert.equal(ev.payload.stageCount, 5);
  assert.equal(ev.payload.stageIds.length, 5);

  // The import seeds the proposal v1: plan_proposed rides the same txn with the
  // version id it creates (sourceImportId = the import, LINA-215 #1).
  const proposed = planEvents[1];
  assert.equal(proposed.type, 'plan_proposed');
  assert.equal(proposed.actorPartyId, GC);
  assert.deepEqual(Object.keys(proposed.payload).sort(),
    ['planVersionId', 'sourceImportId', 'stageCount', 'supersedesVersionId', 'versionNo']);
  assert.equal(proposed.payload.sourceImportId, res.importId);
  assert.equal(proposed.payload.supersedesVersionId, null);
  assert.equal(proposed.payload.stageCount, 5);

  // Header row exists + links the audit event (event is appended first in the txn).
  const header = store._imports[0];
  assert.equal(header.audit_event_id, ev.id, 'plan_import.audit_event_id = the event the ledger append returned');
  assert.equal(header.idempotency_key, 'idem-1');
  assert.equal(header.project_id, PROJECT);
  assert.equal(header.imported_by_party_id, GC);

  // The import-seeded v1 envelope (proposed, authored by the importer, linked to
  // the import) + the importer's authorship stamp, exactly like the 0003 backfill.
  assert.equal(store._versions.length, 1);
  const version = store._versions[0];
  assert.equal(version.id, proposed.payload.planVersionId);
  assert.equal(version.project_id, PROJECT);
  assert.equal(version.version_no, 1);
  assert.equal(version.status, 'proposed');
  assert.equal(version.source_import_id, res.importId);
  assert.equal(version.supersedes_version_id, null);
  assert.equal(version.proposed_by_party_id, GC);
  assert.equal(version.frozen_at, null);

  assert.equal(store._acceptances.length, 1);
  assert.equal(store._acceptances[0].plan_version_id, version.id);
  assert.equal(store._acceptances[0].party_id, GC);
  assert.equal(store._acceptances[0].kind, 'proposed');
  assert.equal(store._acceptances[0].audit_event_id, proposed.id,
    'the authorship stamp links the plan_proposed event (append-only)');

  // Stages written in WBS pre-order at positions 1..5 → ids match the event, in
  // order, and EVERY stage is bound to the seeded version (LINA-215 #1).
  const written = [...store._stages.values()].sort((a, b) => a.position - b.position);
  assert.equal(written.length, 5);
  assert.deepEqual(written.map((s) => s.id), ev.payload.stageIds, 'stage ids ride the audit event in pre-order');
  assert.deepEqual(written.map((s) => s.position), [1, 2, 3, 4, 5]);
  assert.deepEqual(written.map((s) => s.source_row_ref), ['R2', 'R3', 'R4', 'R5', 'R6']);
  assert.equal(written.every((s) => s.import_id === res.importId), true);
  assert.equal(written.every((s) => s.plan_version_id === version.id), true);

  // Parent linkage: sub-actions point at their root, roots at null.
  const byRef = Object.fromEntries(written.map((s) => [s.source_row_ref, s]));
  assert.equal(byRef['R2'].parent_id, null);
  assert.equal(byRef['R3'].parent_id, byRef['R2'].id);
  assert.equal(byRef['R6'].parent_id, byRef['R5'].id);
  assert.equal(byRef['R3'].trade, 'Civil');
  assert.equal(byRef['R6'].trade, 'Carpentry');

  // Dependencies only between rows of the same import (R4→R3, R5→R2, R6→R3,R4).
  const deps = store._dependencies;
  assert.equal(deps.length, 4);
  const depPairs = deps.map((d) => `${byRefId(written, d.stage_id)}->${byRefId(written, d.depends_on_stage_id)}`).sort();
  assert.deepEqual(depPairs, ['R4->R3', 'R5->R2', 'R6->R3', 'R6->R4']);

  function byRefId(written, id) {
    return written.find((s) => s.id === id).source_row_ref;
  }
});

test('confirm: the seeded proposal renders as the D11 current plan (LINA-215: import → plan version)', async () => {
  const { service, store, ledger, identity } = makeHarness();
  // The SAME store/ledger/identity drive the plan-baseline service, exactly as
  // composition.mjs wires both against one port set — so the import is the plan.
  const { createPlanVersionService } = await import('./plan-version.mjs');
  const planVersion = createPlanVersionService({ store, ledger, identity });

  const buf = await makeWorkbook(PLAN);
  await service.confirm(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING, idempotencyKey: 'seed-1' });

  const view = await planVersion.getPlan(PROJECT, OWNER);
  assert.equal(view.baseline, null);
  assert.equal(view.current.versionNo, 1);
  assert.equal(view.current.status, 'proposed');
  assert.equal(view.current.sourceImportId, store._imports[0].id);
  assert.equal(view.current.acceptances.length, 1);
  assert.equal(view.current.acceptances[0].partyId, GC);
  assert.equal(view.current.acceptances[0].kind, 'proposed');
  assert.equal(view.current.stages.length, 2, 'D10 imports both roots');
  assert.equal(view.current.stages[0].name, 'Foundation');
  assert.deepEqual(view.current.stages[0].children.map((c) => c.name), ['Excavate', 'Pour footings']);
  assert.equal(view.history.length, 0);
});

test('confirm: positions append after hand-added stages, not from 1', async () => {
  const { service, store } = makeHarness();
  await store.insertStage({}, {
    id: 'pre-1', project_id: PROJECT, name: 'Kickoff', position: 1, parent_id: null,
    trade: null, import_id: null, source_row_ref: null, scope_note: null,
    planned_start_date: null, planned_end_date: null, planned_cost_cents: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  });
  const buf = await makeWorkbook(PLAN);
  const res = await service.confirm(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING, idempotencyKey: 'idem-2' });
  const written = [...store._stages.values()].filter((s) => s.import_id === res.importId)
    .sort((a, b) => a.position - b.position);
  assert.deepEqual(written.map((s) => s.position), [2, 3, 4, 5, 6]);
});

test('confirm: idempotent on a used key — same result, nothing new written', async () => {
  const { service, store, ledger } = makeHarness();
  const buf = await makeWorkbook(PLAN);
  const opts = { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING, idempotencyKey: 'retry-1' };

  const first = await service.confirm(PROJECT, GC, opts);
  assert.equal(store._imports.length, 1);
  // plan_import + plan_proposed (the import-led proposal, B2 contract §4).
  assert.equal(ledger._events.length, 2);

  const second = await service.confirm(PROJECT, GC, opts);
  assert.deepEqual(second, first, 'replay returns the ORIGINAL result');
  assert.equal(store._imports.length, 1, 'no second header');
  assert.equal(store._stages.size, 5, 'no duplicate stages');
  assert.equal(store._versions.length, 1, 'no second seeded version');
  assert.equal(ledger._events.length, 2, 'the rolled-back ledger append leaves exactly the original two events');
});

test('confirm: refuses a second import while a proposal is open — 409 open_plan_exists (one thread, B2 §1)', async () => {
  const { service, store, ledger } = makeHarness();
  const buf = await makeWorkbook(PLAN);

  await service.confirm(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING, idempotencyKey: 't1' });

  await assert.rejects(
    service.confirm(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING, idempotencyKey: 't2' }),
    (e) => e.status === 409 && e.code === 'open_plan_exists',
    'a second import must not open a second negotiation thread',
  );

  // Nothing from the refused txn leaked in.
  assert.equal(store._imports.length, 1);
  assert.equal(store._versions.length, 1);
  assert.equal(ledger._events.length, 2, 'plan_import + plan_proposed for the first import only');
});

test('confirm: refuses a tree with validation errors — 400 validation_failed with the error list', async () => {
  const { service, store, ledger } = makeHarness();
  const buf = await makeWorkbook({ Plan: [['Framing', '', '2026-02-10', '2026-03-20'], ['', 'Walls', '2026-02-10', '2026-03-01']] });
  await assert.rejects(
    service.confirm(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING, idempotencyKey: 'bad-1' }),
    (e) => e.status === 400 && e.code === 'validation_failed'
      && Array.isArray(e.details.errors) && e.details.errors.length > 0,
  );
  assert.equal(store._imports.length, 0, 'nothing written');
  assert.equal(ledger._events.length, 0, 'no audit event for a dirty tree');
});

test('confirm: an empty mapped sheet is 400 empty_plan', async () => {
  const { service } = makeHarness();
  const buf = await makeWorkbook({ Plan: [] });
  await assert.rejects(
    service.confirm(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING, idempotencyKey: 'e-1' }),
    (e) => e.status === 400 && e.code === 'empty_sheet',
  );
});

test('confirm: requires an idempotency key (400 invalid_idempotency_key)', async () => {
  const { service } = makeHarness();
  const buf = await makeWorkbook(PLAN);
  await assert.rejects(
    service.confirm(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING }),
    (e) => e.status === 400 && e.code === 'invalid_idempotency_key',
  );
});

test('confirm: a missing required mapping is 400, not a partial import', async () => {
  const { service, store, ledger } = makeHarness();
  const buf = await makeWorkbook(PLAN);
  await assert.rejects(
    service.confirm(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: { action: 1 }, idempotencyKey: 'm-1' }),
    (e) => e.status === 400 && e.code === 'missing_required_mapping',
  );
  assert.equal(store._imports.length, 0);
  assert.equal(ledger._events.length, 0);
});

test('ACTION.IMPORT_PLAN exists in the catalogue the service uses', () => {
  assert.equal(ACTION.IMPORT_PLAN, 'import_plan');
});

test('contract §4: the confirm payload hashes reproducibly and its stageIds match the writes in order', async () => {
  const { service, store, ledger } = makeHarness();
  const buf = await makeWorkbook(PLAN);
  await service.confirm(PROJECT, GC, { filename: 'p.xlsx', buffer: buf, sheet: SHEET, mapping: MAPPING, idempotencyKey: 'hash-1' });

  const ev = ledger._events[0];
  // payloadHash is byte-stable: hashing the same committed event twice is identical.
  assert.equal(payloadHash(ev), payloadHash(ev));

  // The in-memory ledger keeps raw events; hash them into a chain the way the pg
  // append does, then prove the whole thing verifies — the imported stage ids
  // (WBS pre-order) plus the import-seed plan_proposed both anchor the chain.
  const chain = [];
  let prev = null;
  for (const e of ledger._events) {
    const appended = computeAppend(prev, e);
    chain.push(appended);
    prev = appended;
  }
  assert.equal(chain.length, 2, 'plan_import + plan_proposed in one confirm txn');
  assert.equal(chain[0].seq, 1);
  assert.equal(chain[0].prevHash, GENESIS_HASH);
  assert.equal(chain[1].type, 'plan_proposed');
  assert.equal(chain[0].entryHash, chain[1].prevHash, 'plan_proposed chains onto the import event');
  assert.deepEqual(verifyChain(chain), { verified: true },
    'chain-verify stays green across plan_import + plan_proposed');

  const written = [...store._stages.values()].sort((a, b) => a.position - b.position);
  assert.deepEqual(written.map((s) => s.id), ev.payload.stageIds, 'stage ids on the event == stages written, in order');
});