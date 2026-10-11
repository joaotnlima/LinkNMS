// Excel plan import — use cases (PRD-09 O-6..O-12; flows/01 screens 8–11).
// One function per operationId: uploadScheduleImport, getScheduleImport,
// mapScheduleImport, previewScheduleImport, confirmScheduleImport.
//
// Authorization (doc 16 conjunction): permission `org:plan:edit` ∧ project
// participant (∧ staffing) ∧ edit scope ∋ the plan root (D-33: the owner, or
// the creator of a still-unclaimed build). An import belongs to the
// organisation that uploaded it; anyone else gets the same 404 as an unknown id.
//
// Ports (injected at the composition root):
//   workbooks   { read(bytes) → {sheets} } — infra/xlsx-reader.mjs (exceljs)
//   specialties { list() → [{code, name_en, name_pt}] } — the directory's
//               taxonomy port, for O-11 (Trade → specialty_code)
//
// The confirm writes through `applySchedule` (the plan editor's structural
// batch) with hooks that run in the SAME plan transaction: refuse a non-empty
// plan, mark the import confirmed, ledger the stamp and publish
// `planning.plan.imported` for the owner's notification (O-12).
import { randomUUID } from 'node:crypto';

import { ProblemError } from '../../../platform/errors.mjs';
import { inEditScope } from '../domain/scope.mjs';
import {
  columnsOf, suggestMapping, missingRequired, validateMapping, parseRows, sheetSummary, SAMPLE_ROWS,
} from '../domain/schedule-import.mjs';
import { buildTree, toCreateBatch } from '../domain/schedule-import-tree.mjs';
import { requireParticipant, applySchedule, commitPlanEvent } from './use-cases.mjs';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const OUT_OF_SCOPE = 'Only the build’s owner brings a plan into an empty plan: a contractor’s part of the plan comes with its contract (D-33).';

/** operationId: uploadScheduleImport — read the .xlsx into sheets + columns. */
export async function uploadScheduleImport({ viewer, store, workbooks, orgs = null, projectId, body }) {
  const { actor } = await requireImporter({ viewer, store, projectId });
  if (body?.parent_task_id) {
    throw new ProblemError('validation_failed', null, {
      errors: { parent_task_id: 'imports land in an empty plan for now (PRD-09 O-9) — leave it out' },
    });
  }
  const file = body?.file;
  const errors = {};
  if (!file || typeof file !== 'object' || !file.bytes) errors.file = 'attach the workbook (.xlsx)';
  else if (!/\.xlsx$/i.test(String(file.filename ?? ''))) errors.file = 'only .xlsx workbooks — save the file as “Excel Workbook (.xlsx)”';
  else if ((file.size ?? file.bytes.length) > MAX_UPLOAD_BYTES) errors.file = 'at most 10 MB';
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });

  let book;
  try {
    book = await workbooks.read(file.bytes);
  } catch {
    throw new ProblemError('validation_failed', null, { errors: { file: 'this file could not be read as an .xlsx workbook' } });
  }
  const sheets = (book?.sheets ?? []).map((s) => ({ name: String(s.name).slice(0, 120), rows: s.rows }));
  if (!sheets.length) throw new ProblemError('validation_failed', null, { errors: { file: 'the workbook has no sheets' } });
  const first = sheets.find((s) => sheetSummary(s).rows > 0) ?? sheets[0];

  const imp = await store.insertScheduleImport({
    id: randomUUID(), projectId, orgId: viewer.orgId, personId: actor.id,
    filename: String(file.filename).slice(0, 255), fileBytes: file.size ?? file.bytes.length,
    sheets, sheetName: first.name,
  });
  return { status: 201, body: await view({ store, orgs, imp }) };
}

/** operationId: getScheduleImport */
export async function getScheduleImport({ viewer, store, specialties, orgs = null, importId }) {
  const imp = await requireImport({ viewer, store, importId, edit: false });
  return { status: 200, body: await view({ store, orgs, imp, specialties }) };
}

/** operationId: mapScheduleImport — sheet + mapping → the live 10-row sample. */
export async function mapScheduleImport({ viewer, store, specialties, orgs = null, importId, body }) {
  const imp = await requireImport({ viewer, store, importId });
  assertOpen(imp);
  const sheet = imp.sheets.find((s) => s.name === body?.sheet);
  if (!sheet) throw new ProblemError('validation_failed', null, { errors: { sheet: 'one of the workbook’s sheets' } });
  const width = Math.max(0, ...sheet.rows.map((r) => r.length));
  const { mapping, errors } = validateMapping(body?.mapping, width);
  if (Object.keys(errors).length) throw new ProblemError('validation_failed', null, { errors });
  const saved = await store.updateScheduleImport({ id: imp.id, sheetName: sheet.name, mapping, status: 'mapped' });
  if (!saved) throw new ProblemError('invalid_transition', 'this import was already confirmed');
  return { status: 200, body: await view({ store, orgs, imp: saved, specialties }) };
}

/** operationId: previewScheduleImport — the WBS tree, counts and warnings. */
export async function previewScheduleImport({ viewer, store, specialties, orgs = null, importId }) {
  const imp = await requireImport({ viewer, store, importId });
  assertOpen(imp);
  assertMapped(imp);
  const saved = await store.updateScheduleImport({ id: imp.id, sheetName: imp.sheetName, mapping: imp.mapping, status: 'previewed' });
  if (!saved) throw new ProblemError('invalid_transition', 'this import was already confirmed');
  return { status: 200, body: await view({ store, orgs, imp: saved, specialties }) };
}

/** operationId: confirmScheduleImport — write into the EMPTY plan, stamp, notify. */
export async function confirmScheduleImport({ viewer, store, specialties, importId, idempotencyKey }) {
  const imp = await requireImport({ viewer, store, importId });
  assertOpen(imp);
  assertMapped(imp);
  const parsed = await parse({ store, imp, specialties });
  if (!parsed.tree.length) {
    throw new ProblemError('validation_failed', null, { errors: { sheet: 'no rows to import on this sheet' } });
  }
  const batch = toCreateBatch(parsed.tree, parsed.links, randomUUID);
  const warnings = [...parsed.rowWarnings, ...parsed.warnings];
  const result = { ...parsed.counts, warnings: warnings.length };

  return applySchedule({
    viewer, store, specialties, projectId: imp.projectId, idempotencyKey,
    operationId: 'confirmScheduleImport',
    body: { operations: [{ op: 'create_rows', rows: batch.rows, links: batch.links }] },
    hooks: {
      idempotencyBody: { import_id: imp.id },
      before: async (plan) => {
        if (!inEditScope({ ownerOrgId: plan.ownerOrgId, contracts: plan.contracts }, { branchContractId: null }, viewer.orgId)) {
          throw new ProblemError('out_of_scope', OUT_OF_SCOPE);
        }
        if (plan.tasks.size > 0) {
          throw new ProblemError('invalid_transition',
            'the plan already has rows — an import goes into an empty plan; reviewing it as a diff is a follow-up',
            { reason: 'plan_not_empty' });
        }
      },
      after: async (plan, _out, me) => {
        if (!(await plan.write.confirmScheduleImport({ id: imp.id, result }))) {
          throw new ProblemError('invalid_transition', 'this import was already confirmed');
        }
        // The importer edits the whole plan (owner or prime) — a party the plan names.
        const orgName = plan.orgNames?.get(viewer.orgId) ?? null;
        await commitPlanEvent(plan, {
          projectId: imp.projectId, actor: me, type: 'planning.plan.imported',
          objectType: 'schedule_import', objectId: imp.id,
          payload: { filename: imp.filename, sheet: imp.sheetName, ...result },
          data: {
            import_id: imp.id, filename: imp.filename, sheet: imp.sheetName,
            actions: result.actions, sub_actions: result.sub_actions, links: result.links, warnings: result.warnings,
            imported_by_org_id: viewer.orgId, imported_by_org_name: orgName, owner_org_id: plan.ownerOrgId ?? null,
          },
        });
      },
    },
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function requireImporter({ viewer, store, projectId }) {
  const { project, actor } = await requireParticipant({ viewer, store, projectId });
  if (!viewer.has('org:plan:edit')) throw new ProblemError('forbidden', null, { reason: 'role' });
  const plan = await store.loadPlan(projectId);
  if (!inEditScope({ ownerOrgId: plan.ownerOrgId, contracts: plan.contracts }, { branchContractId: null }, viewer.orgId)) {
    throw new ProblemError('out_of_scope', OUT_OF_SCOPE);
  }
  return { project, actor };
}

/** The import, for its own organisation only (404 otherwise), on a build the viewer reads. */
async function requireImport({ viewer, store, importId, edit = true }) {
  const imp = /^[0-9a-f-]{36}$/i.test(importId ?? '') ? await store.getScheduleImport(importId) : null;
  if (!imp || imp.orgId !== viewer.orgId) throw new ProblemError('not_found');
  await requireParticipant({ viewer, store, projectId: imp.projectId });
  if (edit && !viewer.has('org:plan:edit')) throw new ProblemError('forbidden', null, { reason: 'role' });
  return imp;
}

function assertOpen(imp) {
  if (imp.status === 'confirmed') throw new ProblemError('invalid_transition', 'this import was already confirmed');
}

function assertMapped(imp) {
  const missing = imp.mapping ? missingRequired(imp.mapping) : ['action', 'start', 'end'];
  if (missing.length) {
    throw new ProblemError('validation_failed', null, {
      errors: { mapping: `map ${missing.join(', ')} first (Action, Start and End or Duration are required)` },
    });
  }
}

async function taxonomyOf(specialties) {
  try {
    return specialties?.list ? await specialties.list() : [];
  } catch {
    return []; // O-11 is a "could": no taxonomy, no codes — the trade text still lands
  }
}

async function parse({ store, imp, specialties }) {
  const sheet = imp.sheets.find((s) => s.name === imp.sheetName) ?? imp.sheets[0];
  const { rows, warnings: rowWarnings } = parseRows(sheet.rows, imp.mapping ?? {}, { taxonomy: await taxonomyOf(specialties) });
  const plan = await store.loadPlan(imp.projectId);
  const built = buildTree(rows, { calendar: plan.calendarRaw });
  return { rows, rowWarnings, ...built, planExists: plan.tasks.size > 0 };
}

/** The ScheduleImport body for the import's stage. */
async function view({ store, orgs, imp, specialties }) {
  // Named through identity's organisation port (planning never reads identity.*).
  const orgName = orgs ? (await orgs.namesOf([imp.orgId])).get(imp.orgId) ?? null : null;
  const sheet = imp.sheets.find((s) => s.name === imp.sheetName) ?? imp.sheets[0] ?? { name: null, rows: [] };
  const columns = columnsOf(sheet.rows);
  const suggested = !imp.mapping;
  const mapping = imp.mapping ?? suggestMapping(columns);
  const body = {
    id: imp.id,
    project_id: imp.projectId,
    status: imp.status,
    filename: imp.filename,
    sheets: imp.sheets.map(sheetSummary),
    sheet: sheet.name,
    columns,
    mapping,
    mapping_suggested: suggested,
    missing_required: missingRequired(mapping),
    imported_by: { org_id: imp.orgId, ...(orgName ? { org_name: orgName } : {}) },
    confirmed_at: imp.confirmedAt ?? null,
  };
  if (imp.status === 'uploaded') {
    const plan = await store.loadPlan(imp.projectId);
    return { ...body, plan_exists: plan.tasks.size > 0, warnings: [] };
  }
  const parsed = await parse({ store, imp: { ...imp, mapping }, specialties });
  const warnings = [...parsed.rowWarnings, ...parsed.warnings].sort((a, b) => a.row - b.row);
  const out = {
    ...body,
    plan_exists: imp.status === 'confirmed' ? false : parsed.planExists,
    sample: parsed.rows.slice(0, SAMPLE_ROWS),
    counts: { ...parsed.counts, warnings: warnings.length },
    warnings,
  };
  if (imp.status === 'previewed' || imp.status === 'confirmed') out.tree = parsed.tree;
  if (imp.status === 'confirmed' && imp.result) out.counts = { ...out.counts, ...imp.result };
  return out;
}
