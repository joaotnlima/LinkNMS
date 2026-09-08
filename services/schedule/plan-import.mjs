// Slice B1 plan import — the service orchestration (LINA-206; frozen contract
// docs/architecture/slice-b1-plan-import-contract.md §2–§5; ADR-0002/0005/0006 §1).
//
// Four GC-scoped routes, stateless parse → single write:
//   :inspect  — sheet list (no writes)
//   :columns  — header + samples (no writes)
//   :preview  — WBS tree / warnings / errors (no writes)
//   :confirm  — ONE transaction: stage ids (WBS pre-order) → ledger append →
//               plan_import header → stage rows (parents before children) →
//               stage_dependency rows. Exactly ONE `plan_import` audit event for
//               the whole batch (contract §0), and idempotent on `idempotencyKey`
//               (contract §2).
//
// Authorization: `IMPORT_PLAN` via the identity port, counterparty/GC only, and
// always scoped to projectId. `actorPartyId` comes from the session (ADR-0004),
// never the request body. Confirm re-parses the re-sent file server-side — the
// preview the client rendered is never trusted as the write payload.
import { randomUUID } from 'node:crypto';
import { ACTION, DomainError } from './ports.mjs';

const PG_UNIQUE_VIOLATION = '23505';
const IDEMPOTENCY_CONSTRAINT = 'plan_import_idempotency_key_key';

const now = () => new Date().toISOString();

// The single-stage WBS shape the preview returns (contract §2). Strips the
// parser's internal shell fields down to exactly the contract fields.
function toWBSNode(n) {
  return {
    ref: n.ref,
    action: n.action,
    subActionOf: n.subActionOf,
    start: n.start,
    end: n.end,
    trade: n.trade,
    dependsOn: [...n.dependsOn],
    children: n.children.map(toWBSNode),
  };
}

export function createPlanImportService({ store, parser, ledger, identity }) {
  if (!store || !parser || !ledger || !identity) {
    throw new Error('createPlanImportService requires { store, parser, ledger, identity } ports');
  }

  async function authorize(projectId, actorPartyId) {
    return identity.authorize({ actorPartyId, action: ACTION.IMPORT_PLAN, projectId });
  }

  // POST /projects/:projectId/plan-imports:inspect
  async function inspect(projectId, actorPartyId, { filename, buffer } = {}) {
    await authorize(projectId, actorPartyId);
    return parser.inspectSheets(buffer, { filename });
  }

  // POST /projects/:projectId/plan-imports:columns
  async function columns(projectId, actorPartyId, { filename, buffer, sheet } = {}) {
    await authorize(projectId, actorPartyId);
    if (!sheet || typeof sheet !== 'string' || !sheet.trim()) {
      throw new DomainError(400, 'invalid_sheet', 'sheet name is required');
    }
    const workbook = await parser.openWorkbook(buffer, { filename });
    return parser.inspectColumns(workbook, sheet);
  }

  // POST /projects/:projectId/plan-imports:preview
  async function preview(projectId, actorPartyId, { filename, buffer, sheet, mapping } = {}) {
    await authorize(projectId, actorPartyId);
    if (!sheet || typeof sheet !== 'string' || !sheet.trim()) {
      throw new DomainError(400, 'invalid_sheet', 'sheet name is required');
    }
    const workbook = await parser.openWorkbook(buffer, { filename });
    const tree = parser.buildTree(workbook, sheet, mapping);
    return {
      roots: tree.roots.map(toWBSNode),
      warnings: tree.warnings,
      errors: tree.errors,
      stats: tree.stats,
    };
  }

  // POST /projects/:projectId/plan-imports:confirm
  async function confirm(projectId, actorPartyId, { filename, buffer, sheet, mapping, idempotencyKey } = {}) {
    await authorize(projectId, actorPartyId);
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 200) {
      throw new DomainError(400, 'invalid_idempotency_key',
        'idempotencyKey is required (a non-empty string, ≤ 200 chars)');
    }
    if (!sheet || typeof sheet !== 'string' || !sheet.trim()) {
      throw new DomainError(400, 'invalid_sheet', 'sheet name is required');
    }

    // Re-parse server-side. The client's preview is never trusted as the write
    // payload (contract §2). Preview errors → 400: confirm never writes a dirty tree.
    const workbook = await parser.openWorkbook(buffer, { filename });
    const tree = parser.buildTree(workbook, sheet, mapping);
    if (tree.errors.length > 0) {
      throw new DomainError(400, 'validation_failed',
        `cannot import — the plan has ${tree.errors.length} validation error(s)`,
        { errors: tree.errors });
    }
    if (tree.stats.stageCount === 0) {
      throw new DomainError(400, 'empty_plan', 'the mapped sheet contains no stages to import');
    }

    // Deterministic stage ids FIRST (WBS pre-order) so they ride the single audit
    // event and the payload_hash reproduces on verify (contract §4).
    const stageIds = tree.order.map(() => randomUUID());

    const writeImport = async (tx) => {
      const importedAt = now();
      const importId = randomUUID();
      const columnMapping = parser.normalizeMapping(mapping);

      // 1. The one audit event for the whole batch. It is appended FIRST in the
      //   txn: plan_import is INSERT+SELECT only, so its NOT NULL audit_event_id
      //   can only be the id the ledger append returns (contract §3 note, §4).
      const event = await ledger.append(tx, {
        projectId,
        type: 'plan_import',
        actorPartyId,
        occurredAt: importedAt,
        payload: {
          importId,
          filename: String(filename ?? ''),
          sheetName: sheet,
          columnMapping,
          stageCount: tree.stats.stageCount,
          rootCount: tree.stats.rootCount,
          stageIds,
        },
      });

      // 2. The append-only import header.
      await store.insertPlanImport(tx, {
        id: importId,
        project_id: projectId,
        filename: String(filename ?? ''),
        sheet_name: sheet,
        column_mapping: columnMapping,
        row_count: tree.stats.stageCount,
        idempotency_key: idempotencyKey,
        imported_by_party_id: actorPartyId,
        imported_at: importedAt,
        audit_event_id: event.id,
      });

      // 3. Stage rows, parents before children, WBS pre-order; positions append
      //   after any hand-added stages so plan order stays deterministic.
      const base = await store.maxStagePosition(projectId);
      const idByRef = new Map();
      const stages = [];
      for (let i = 0; i < tree.order.length; i += 1) {
        const node = tree.order[i];
        const id = stageIds[i];
        idByRef.set(node.ref, id);
        const created = now();
        stages.push({
          id,
          project_id: projectId,
          name: node.action,
          position: base + i + 1,
          parent_id: node.subActionOf ? idByRef.get(node.subActionOf) : null,
          trade: node.trade ?? null,
          import_id: importId,
          source_row_ref: node.ref,
          scope_note: null,
          planned_start_date: node.start ?? null,
          planned_end_date: node.end ?? null,
          planned_cost_cents: null,
          created_at: created,
          updated_at: created,
        });
      }
      for (const s of stages) await store.insertStage(tx, s);

      // 4. Intra-import predecessors.
      for (const node of tree.order) {
        const stageId = idByRef.get(node.ref);
        for (const depRef of node.dependsOn) {
          await store.insertStageDependency(tx, stageId, idByRef.get(depRef));
        }
      }

      return {
        importId,
        auditEventId: event.id,
        stageCount: stages.length,
        rootCount: tree.stats.rootCount,
      };
    };

    // The idempotent-replay lookup runs OUTSIDE the transaction. In Postgres an
    // errored statement aborts the whole tx (25P02), so reading the original
    // header back inside the catch of the same tx would itself fail; instead the
    // tx rolls back the phantom ledger append and we read the original cleanly.
    try {
      return await store.transaction(writeImport);
    } catch (err) {
      if (err && err.code === PG_UNIQUE_VIOLATION
        && err.constraint === IDEMPOTENCY_CONSTRAINT) {
        const existing = await store.getPlanImportByIdempotencyKey(idempotencyKey);
        if (existing) {
          const counts = await store.importStageCounts(existing.id);
          return {
            importId: existing.id,
            auditEventId: existing.audit_event_id,
            stageCount: counts.stageCount,
            rootCount: counts.rootCount,
          };
        }
      }
      throw err;
    }
  }

  return { inspect, columns, preview, confirm };
}