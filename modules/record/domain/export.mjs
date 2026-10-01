// Record export artefact (LINA-374) — pure: shape the self-proving JSON a
// record export persists. No I/O, no clock, no database.
//
// The artefact is the VIEWER's V7-redacted projection of the whole ledger plus
// the chain-verification report, so an exported record proves itself: the
// `verification` header is `verifyRecord`'s output (recomputed in SQL), and the
// `entries` are the same AuditEntry shapes `listRecord` returns — redacted rows
// keep only seq/hashes so the chain still reads end to end (invariant V7).
//
// This is the "M core" of the W5 court-usable export (to-be/21): JSON first,
// viewer-redacted first. Full-access (W5 §W5) and PDF are later, separable cuts.
import { toAuditEntry } from './redaction.mjs';

export const EXPORT_FORMAT_VERSION = 1;

/**
 * @param {{
 *   projectId: string,
 *   projectName?: string|null,
 *   rows: object[],                 // raw ledger rows, chain order (seq ASC), each with `visible`
 *   verification: { valid: boolean, length: number, head: string|null, first_invalid_seq: number|null },
 *   generatedAt: string,            // ISO instant (the caller stamps the clock)
 *   actor: { person_id: string|null, org_id: string|null, org_role: string|null },
 * }} input
 * @returns {object} the artefact body (serialise with JSON.stringify)
 */
export function buildRecordExport({ projectId, projectName = null, rows, verification, generatedAt, actor }) {
  const entries = rows.map(toAuditEntry);
  const redactedCount = entries.reduce((n, e) => n + (e.redacted ? 1 : 0), 0);
  return {
    export: {
      artefact: 'record_export',
      format: 'json',
      format_version: EXPORT_FORMAT_VERSION,
      project_id: projectId,
      project_name: projectName,
      generated_at: generatedAt,
      generated_by: {
        person_id: actor.person_id ?? null,
        org_id: actor.org_id ?? null,
        org_role: actor.org_role ?? null,
      },
      // The projection is scoped to the requesting org (V7). A co-participant
      // with narrower access would see MORE redacted rows — this artefact is
      // this org's view, which is why its download is private to this org.
      redaction: 'V7',
      entry_count: entries.length,
      redacted_count: redactedCount,
      // The self-proving header: recomputed in the database, byte-for-byte.
      verification: {
        valid: verification.valid,
        length: verification.length,
        head: verification.head ?? null,
        first_invalid_seq: verification.first_invalid_seq ?? null,
      },
    },
    entries,
  };
}

/**
 * The filename a downloaded export carries. Date only (no colons — the download
 * disposition and the storage key both prefer a clean name).
 *
 * @param {{ generatedAt: string }} o
 */
export function exportFileName({ generatedAt }) {
  const day = String(generatedAt).slice(0, 10);
  return `record-export-${day}.json`;
}
