// HTTP-layer contract tests for Schedule & Progress (LINA-69; ADR-0004). These
// prove the two properties the gateway relies on, independent of Next:
//   - the acting party is taken from the session, NEVER the body (a forged
//     reportedBy is inert);
//   - every authorization denial is a typed 4xx envelope, never a 500 (spec §8.2,
//     LINA-56 finding).
// Plus the Slice B1 plan-import surface (LINA-206): the four routes read the
// `.xlsx` from `file` (the multipart seam the gateway transport fills), return
// the platform envelope, and keep confirm's validation list in `error.details`.
// Run: node --test services/schedule/http.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleService } from './schedule.mjs';
import { createPlanImportService } from './plan-import.mjs';
import { PARSER } from './plan-import-parser.mjs';
import { createScheduleHttp } from './http.mjs';
import { createInMemoryLedger, createInMemoryStore, createInMemoryIdentity } from './ports.mjs';
import { makeWorkbook } from './plan-import-parser.test.mjs';

const PROJECT = 'proj-1';
const HOMEOWNER = 'party-homeowner';
const GC = 'party-gc';

function build() {
  const store = createInMemoryStore();
  const ledger = createInMemoryLedger({ baselines: new Map([[PROJECT, 5_000_000]]) });
  const identity = createInMemoryIdentity({
    memberships: [
      { projectId: PROJECT, partyId: HOMEOWNER, role: 'owner' },
      { projectId: PROJECT, partyId: GC, role: 'counterparty' },
    ],
  });
  const service = createScheduleService({ store, ledger, identity });
  const planImport = createPlanImportService({ store, parser: PARSER, ledger, identity });
  return createScheduleHttp({ service, planImport });
}

const gc = { partyId: GC };
const homeowner = { partyId: HOMEOWNER };

const PLAN = {
  Plan: [
    ['Foundation', '', '2026-01-05', '2026-02-02'],
    ['Foundation', 'Excavate', '2026-01-05', '2026-01-15'],
    ['Foundation', 'Footings', '2026-01-16', '2026-02-02', 'R2'],
    ['Framing', '', '2026-02-10', '2026-03-20'],
    ['Framing', 'Walls', '2026-02-10', '2026-03-01'],
  ],
};
const MAPPING = { action: 1, subAction: 2, start: 3, end: 4, dependency: 5 };
const FILE = (buf) => ({ filename: 'plan.xlsx', buffer: buf, sheet: 'Plan', mapping: MAPPING });

test('POST /projects/:id/stages — GC adds a stage → 201', async () => {
  const http = build();
  const res = await http.addStage({
    session: gc, params: { projectId: PROJECT },
    body: { name: 'Foundation', position: 1, plannedCostCents: 1_000_000 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Foundation');
  assert.equal(res.body.currentStatus, 'not_started');
});

test('the actor is the session, never the body — a forged reportedBy is inert', async () => {
  const http = build();
  const created = await http.addStage({ session: gc, params: { projectId: PROJECT }, body: { name: 'A', position: 1 } });
  const stageId = created.body.id;

  // Body claims the homeowner is acting, but the session is the GC → allowed, and
  // the report is attributed to the GC, not the body's claim.
  const res = await http.reportProgress({
    session: gc, params: { stageId },
    body: { status: 'in_progress', percent: 30, reportedBy: HOMEOWNER, actorPartyId: HOMEOWNER },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.history[0].reportedBy, GC);
});

test('homeowner stage authoring → 403 envelope, not 500 (spec §8.2)', async () => {
  const http = build();

  // Authoring the WBS stays GC-only: a homeowner add is a typed denial.
  const add = await http.addStage({ session: homeowner, params: { projectId: PROJECT }, body: { name: 'X', position: 2 } });
  assert.equal(add.status, 403);
  assert.equal(add.body.error.code, 'forbidden');
});

test('LINA-306: homeowner (owner) MAY report progress → 201, attributed to the owner', async () => {
  const http = build();
  const created = await http.addStage({ session: gc, params: { projectId: PROJECT }, body: { name: 'A', position: 1 } });
  const stageId = created.body.id;

  const report = await http.reportProgress({ session: homeowner, params: { stageId }, body: { status: 'done' } });
  assert.equal(report.status, 201);
  assert.equal(report.body.currentStatus, 'done');
  assert.equal(report.body.history[0].reportedBy, HOMEOWNER);
});

test('unauthenticated (no session) → 401 envelope', async () => {
  const http = build();
  const res = await http.addStage({ session: null, params: { projectId: PROJECT }, body: { name: 'A', position: 1 } });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'unauthenticated');
});

test('GET /projects/:id/plan — both parties read the timeline + rollup', async () => {
  const http = build();
  await http.addStage({ session: gc, params: { projectId: PROJECT }, body: { name: 'A', position: 1 } });
  for (const s of [gc, homeowner]) {
    const res = await http.getPlan({ session: s, params: { projectId: PROJECT } });
    assert.equal(res.status, 200);
    assert.equal(res.body.totalStages, 1);
    assert.ok('headline' in res.body && 'allocation' in res.body);
  }
});

test('a bad status is a typed 400, not a 500', async () => {
  const http = build();
  const created = await http.addStage({ session: gc, params: { projectId: PROJECT }, body: { name: 'A', position: 1 } });
  const res = await http.reportProgress({ session: gc, params: { stageId: created.body.id }, body: { status: 'nope' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_status');
});

test('plan-import :inspect → 200 with sheets + limits, GC only', async () => {
  const http = build();
  const buf = await makeWorkbook(PLAN, { header: ['Action', 'Sub-action', 'Start', 'End', 'Dependency'] });
  const res = await http.inspectPlanImport({ session: gc, params: { projectId: PROJECT }, file: { filename: 'plan.xlsx', buffer: buf } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sheets.map((s) => s.name), ['Plan']);
  assert.ok(res.body.limits.maxFileBytes > 0);

  const denied = await http.inspectPlanImport({ session: homeowner, params: { projectId: PROJECT }, file: { filename: 'plan.xlsx', buffer: buf } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');

  const anon = await http.inspectPlanImport({ session: null, params: { projectId: PROJECT }, file: { filename: 'plan.xlsx', buffer: buf } });
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, 'unauthenticated');
});

test('plan-import :columns → 200 with headers + samples; missing sheet → 400', async () => {
  const http = build();
  const buf = await makeWorkbook(PLAN, { header: ['Action', 'Sub-action', 'Start', 'End', 'Dependency'] });
  const res = await http.columnsPlanImport({ session: gc, params: { projectId: PROJECT }, file: FILE(buf) });
  assert.equal(res.status, 200);
  assert.equal(res.body.columns[0].header, 'Action');
  assert.deepEqual(res.body.columns[0].sampleValues, ['Foundation', 'Foundation', 'Foundation']);
  assert.equal(res.body.rowCount, 5);

  const bad = await http.columnsPlanImport({ session: gc, params: { projectId: PROJECT }, file: { filename: 'plan.xlsx', buffer: buf, sheet: ' ' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'invalid_sheet');
});

test('plan-import :preview → 200 WBS tree; validation errors ride the 200 payload', async () => {
  const http = build();
  const buf = await makeWorkbook({ Plan: [['Framing', '', '2026-02-10', '2026-03-20'], ['', 'Walls', '2026-02-10', '2026-03-01']] });
  const res = await http.previewPlanImport({ session: gc, params: { projectId: PROJECT }, file: FILE(buf) });
  assert.equal(res.status, 200);
  assert.ok(res.body.errors.some((e) => e.includes('no action name')), JSON.stringify(res.body.errors));
  assert.equal(res.body.stats.rootCount, 1);
  assert.deepEqual(Object.keys(res.body).sort(), ['errors', 'roots', 'stats', 'warnings']);
});

test('plan-import :confirm → 201 with importId, one audit event, and is 403 for the homeowner', async () => {
  const http = build();
  const buf = await makeWorkbook(PLAN, { header: ['Action', 'Sub-action', 'Start', 'End', 'Dependency'] });
  const ok = await http.confirmPlanImport({ session: gc, params: { projectId: PROJECT }, file: { ...FILE(buf), idempotencyKey: 'k-http-1' } });
  assert.equal(ok.status, 201);
  assert.ok(ok.body.importId);
  assert.ok(ok.body.auditEventId);
  assert.equal(ok.body.stageCount, 5);
  assert.equal(ok.body.rootCount, 2);

  const denied = await http.confirmPlanImport({ session: homeowner, params: { projectId: PROJECT }, file: { ...FILE(buf), idempotencyKey: 'k-http-2' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');
});

test('plan-import :confirm validation failure → 400 with the error list in details', async () => {
  const http = build();
  const buf = await makeWorkbook({ Plan: [['Framing', '', '2026-02-10', '2026-03-20'], ['', 'Walls', '2026-02-10', '2026-03-01']] });
  const res = await http.confirmPlanImport({ session: gc, params: { projectId: PROJECT }, file: { ...FILE(buf), idempotencyKey: 'k-http-3' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'validation_failed');
  assert.ok(Array.isArray(res.body.error.details.errors) && res.body.error.details.errors.length > 0);
});

test('plan-import :confirm missing idempotency key → 400 invalid_idempotency_key', async () => {
  const http = build();
  const buf = await makeWorkbook(PLAN, { header: ['Action', 'Sub-action', 'Start', 'End', 'Dependency'] });
  const res = await http.confirmPlanImport({ session: gc, params: { projectId: PROJECT }, file: FILE(buf) });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'invalid_idempotency_key');
});
