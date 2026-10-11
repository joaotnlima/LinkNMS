// PRD-09 Excel import over the REAL v2 migrations (throwaway DB) and a real
// .xlsx built with exceljs. Skipped without DATABASE_URL. Proves the acceptance
// criterion end to end, at the use-case level:
//   O-6  multi-sheet workbook → sheets, first sheet with data, columns, a
//        suggested mapping; a non-.xlsx is a 422 on `file`;
//   O-7  the mapping answers a live sample; only missing required mappings
//        block (preview/confirm 422);
//   O-8  preview: the WBS tree with counts and warnings (2 bad dates);
//   O-9  confirm writes every row into the EMPTY plan (merged/blank Action
//        cells inherit), with links; a second confirm is refused;
//   O-11 a trade that names a taxonomy label lands as specialty_code;
//   O-12 the ledger stamp and `planning.plan.imported` (owner named) commit
//        with the rows; D-33: a contractor without a contract may not import.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import ExcelJS from 'exceljs';

import { createPlanningStore } from './pg-store.mjs';
import { xlsxWorkbooks } from './xlsx-reader.mjs';
import {
  uploadScheduleImport, mapScheduleImport, previewScheduleImport, confirmScheduleImport, getScheduleImport,
} from '../application/schedule-import.mjs';
import { getSchedule } from '../application/use-cases.mjs';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'set DATABASE_URL to run the planning Postgres suite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB = 'linknms_planning_import_test';

const OWNER_ORG = randomUUID();
const GC_ORG = randomUUID();
const PERSON = randomUUID();
const PROJECT = randomUUID();
const TAXONOMY = [{ code: 'structure', name_en: 'Structure', name_pt: 'Estrutura' }];
const specialties = {
  async list() { return TAXONOMY; },
  async exists(code) { return TAXONOMY.some((t) => t.code === code); },
};

function viewer(orgId) {
  return { clerkUserId: 'user_gc', personId: PERSON, orgId, orgRole: 'admin', channel: 'ui', has: () => true };
}

async function workbook() {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Capa').addRow(['Cronograma — Casa Almeida']).commit?.();
  const ws = wb.addWorksheet('Cronograma');
  ws.addRow(['Tarefa', 'Subtarefa', 'Início', 'Fim', 'Especialidade', 'Depende de']);
  ws.addRow(['Fundações', '', new Date(Date.UTC(2026, 8, 1)), new Date(Date.UTC(2026, 8, 22)), 'Estrutura', '']);
  ws.addRow(['Fundações', 'Escavação', new Date(Date.UTC(2026, 8, 1)), new Date(Date.UTC(2026, 8, 4)), '', '']);
  ws.addRow(['', 'Armaduras', '07/09/2026', '11/09/2026', '', 'Escavação']);
  ws.addRow(['', 'Betonagem', '14/09/2026', 'sexta', '', 'Armaduras']);
  ws.addRow(['Estrutura', '', '23/09/2026', '20/10/2026', 'Estrutura', 'R2']);
  ws.addRow(['Cobertura', '', '31/09/2026', '30/10/2026', '', 'Estrutura']);
  ws.mergeCells('A3:A5'); // merged Action cells over the sub-rows
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('Excel import over Postgres (PRD-09)', { skip }, () => {
  let pg, admin, pool, store, imp;

  before(async () => {
    ({ default: pg } = await import('pg'));
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    pool = new pg.Pool({ connectionString: url.replace(/\/[^/]*$/, `/${DB}`), max: 3 });
    for (const f of readdirSync(join(ROOT, 'db', 'v2')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
      await pool.query(readFileSync(join(ROOT, 'db', 'v2', f), 'utf8'));
    }
    await pool.query(
      `INSERT INTO identity.organization (id, clerk_org_id, kind, legal_name) VALUES
         ($1, 'o1', 'household', 'Família Almeida'), ($2, 'o2', 'contractor', 'Ferreira Construção')`,
      [OWNER_ORG, GC_ORG],
    );
    await pool.query(`INSERT INTO identity.person (id, clerk_user_id, email, name) VALUES ($1, 'user_gc', 'n@x.pt', 'Nuno')`, [PERSON]);
    await pool.query(
      `INSERT INTO project.project (id, owner_org_id, created_by_org_id, name, municipality_code) VALUES ($1, $2, $2, 'Casa Almeida', '1111')`,
      [PROJECT, OWNER_ORG],
    );
    await pool.query(
      `INSERT INTO project.participation (project_id, org_id, capacity, source, invite_capacity) VALUES
         ($1, $2, 'owner', 'project', NULL), ($1, $3, 'consultant', 'invitation', 'contractor')`,
      [PROJECT, OWNER_ORG, GC_ORG],
    );
    store = createPlanningStore(pool);
  });

  after(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin?.end();
  });

  test('D-33: an invited contractor without a contract may not import into the plan root', async () => {
    const bytes = await workbook();
    await assert.rejects(
      uploadScheduleImport({ viewer: viewer(GC_ORG), store, workbooks: xlsxWorkbooks, projectId: PROJECT, body: { file: { filename: 'plano.xlsx', bytes } } }),
      (err) => err.problem?.code === 'out_of_scope',
    );
  });

  test('O-6: upload reads sheets, picks the first with data, suggests a mapping; non-xlsx is refused', async () => {
    await assert.rejects(
      uploadScheduleImport({ viewer: viewer(OWNER_ORG), store, workbooks: xlsxWorkbooks, projectId: PROJECT, body: { file: { filename: 'plano.csv', bytes: Buffer.from('a,b') } } }),
      (err) => err.problem?.code === 'validation_failed' && !!err.problem.errors.file,
    );
    await assert.rejects(
      uploadScheduleImport({ viewer: viewer(OWNER_ORG), store, workbooks: xlsxWorkbooks, projectId: PROJECT, body: { file: { filename: 'fake.xlsx', bytes: Buffer.from('not a zip') } } }),
      (err) => err.problem?.code === 'validation_failed',
    );
    const res = await uploadScheduleImport({
      viewer: viewer(OWNER_ORG), store, workbooks: xlsxWorkbooks, projectId: PROJECT,
      body: { file: { filename: 'plano-casa-almeida.xlsx', bytes: await workbook() } },
    });
    assert.equal(res.status, 201);
    imp = res.body;
    assert.deepEqual(imp.sheets.map((s) => [s.name, s.rows]), [['Capa', 0], ['Cronograma', 6]]);
    assert.equal(imp.sheet, 'Cronograma');
    assert.equal(imp.mapping_suggested, true);
    assert.deepEqual(imp.mapping, { sub_action: 1, action: 0, start: 2, end: 3, trade: 4, dependency: 5 });
    assert.equal(imp.plan_exists, false);
  });

  test('O-7: map answers a live sample; a missing required mapping blocks preview, not map', async () => {
    const partial = await mapScheduleImport({ viewer: viewer(OWNER_ORG), store, specialties, importId: imp.id, body: { sheet: 'Cronograma', mapping: { action: 0, sub_action: 1 } } });
    assert.deepEqual(partial.body.missing_required, ['start', 'end']);
    await assert.rejects(previewScheduleImport({ viewer: viewer(OWNER_ORG), store, specialties, importId: imp.id }),
      (err) => err.problem?.code === 'validation_failed');
    const mapped = await mapScheduleImport({ viewer: viewer(OWNER_ORG), store, specialties, importId: imp.id, body: { sheet: 'Cronograma', mapping: imp.mapping } });
    assert.equal(mapped.body.status, 'mapped');
    assert.equal(mapped.body.sample.length, 6);
    assert.deepEqual(mapped.body.sample.slice(1, 4).map((r) => r.action), ['Fundações', 'Fundações', 'Fundações']);
    assert.equal(mapped.body.sample[0].start, '2026-09-01');
    // Another org never sees the import.
    await assert.rejects(getScheduleImport({ viewer: viewer(GC_ORG), store, importId: imp.id }), (err) => err.problem?.code === 'not_found');
  });

  test('O-8: preview — tree, counts, two bad-date warnings', async () => {
    const res = await previewScheduleImport({ viewer: viewer(OWNER_ORG), store, specialties, importId: imp.id });
    const b = res.body;
    assert.equal(b.status, 'previewed');
    assert.deepEqual(b.tree.map((a) => [a.name, a.children.length]), [['Fundações', 3], ['Estrutura', 0], ['Cobertura', 0]]);
    assert.deepEqual([b.counts.actions, b.counts.sub_actions, b.counts.links], [3, 3, 4]);
    assert.deepEqual(b.warnings.filter((w) => w.code === 'bad_date').map((w) => w.row), [5, 7]);
    assert.equal(b.tree[0].specialty_code, 'structure');
  });

  test('O-9, O-11, O-12: confirm writes the rows, the links, the stamp and the event — once', async () => {
    const res = await confirmScheduleImport({ viewer: viewer(OWNER_ORG), store, specialties, importId: imp.id, idempotencyKey: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.created.length, 6);
    assert.equal(res.body.links_created.length, 4);

    const plan = await getSchedule({ viewer: viewer(OWNER_ORG), store, projectId: PROJECT, query: {} });
    const names = plan.body.tasks.map((t) => t.name);
    for (const n of ['Fundações', 'Escavação', 'Armaduras', 'Betonagem', 'Estrutura', 'Cobertura']) assert.ok(names.includes(n), n);
    const escav = plan.body.tasks.find((t) => t.name === 'Escavação');
    assert.deepEqual([escav.start, escav.finish, escav.specialty_code], ['2026-09-01', '2026-09-04', 'structure']);
    const armaduras = plan.body.tasks.find((t) => t.name === 'Armaduras');
    assert.deepEqual([armaduras.start, armaduras.finish], ['2026-09-07', '2026-09-11']); // the link kept the file's dates

    const { rows: [evt] } = await pool.query(`SELECT data FROM platform.outbox WHERE type = 'planning.plan.imported'`);
    assert.equal(evt.data.owner_org_id, OWNER_ORG);
    assert.deepEqual([evt.data.actions, evt.data.sub_actions, evt.data.imported_by_org_name], [3, 3, 'Família Almeida']);
    const { rows: [stamp] } = await pool.query(`SELECT payload FROM record.audit_event WHERE type = 'planning.plan.imported'`);
    assert.equal(stamp.payload.actions, 3);

    const again = await getScheduleImport({ viewer: viewer(OWNER_ORG), store, importId: imp.id });
    assert.equal(again.body.status, 'confirmed');
    assert.ok(again.body.confirmed_at);
    await assert.rejects(confirmScheduleImport({ viewer: viewer(OWNER_ORG), store, specialties, importId: imp.id }),
      (err) => err.problem?.code === 'invalid_transition');
  });

  test('O-9: a second import into a plan that has rows answers plan_not_empty', async () => {
    const up = await uploadScheduleImport({
      viewer: viewer(OWNER_ORG), store, workbooks: xlsxWorkbooks, projectId: PROJECT,
      body: { file: { filename: 'again.xlsx', bytes: await workbook() } },
    });
    assert.equal(up.body.plan_exists, true);
    await mapScheduleImport({ viewer: viewer(OWNER_ORG), store, specialties, importId: up.body.id, body: { sheet: 'Cronograma', mapping: up.body.mapping } });
    await assert.rejects(confirmScheduleImport({ viewer: viewer(OWNER_ORG), store, specialties, importId: up.body.id }),
      (err) => err.problem?.code === 'invalid_transition' && err.problem.reason === 'plan_not_empty');
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM planning.task WHERE project_id = $1`, [PROJECT]);
    assert.equal(n, 6);
  });
});
