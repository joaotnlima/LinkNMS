// buildRecordExport — pure artefact shaping. Proves the self-proving header
// (verification), the V7 passthrough (redacted rows stay skeletal), chain order
// preservation and the counts, with no store and no clock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildRecordExport, exportFileName, EXPORT_FORMAT_VERSION } from './export.mjs';

const PROJECT = '01920000-0000-7000-8000-0000000000b1';
const ME = '01920000-0000-7000-8000-0000000000c1';
const ORG = '01920000-0000-7000-8000-0000000000a1';
const OBJ = '01920000-0000-7000-8000-0000000000d1';

function rows() {
  return [
    {
      seq: '1', occurred_at: '2026-09-28T10:00:00.000Z', category: 'project',
      type: 'project.created', actor_person_id: ME, actor_org_id: ORG,
      actor_org_role: 'manager', object_type: 'project', object_id: PROJECT,
      payload: { name: 'Casa' }, entry_hash: 'cc'.repeat(32), prev_hash: null,
      visible: true,
    },
    {
      seq: '2', occurred_at: '2026-09-28T11:00:00.000Z', category: 'contracting',
      type: 'contracting.change_order.approved', actor_person_id: ME, actor_org_id: ORG,
      actor_org_role: 'manager', object_type: 'change_order', object_id: OBJ,
      payload: { delta_cents: 5000 }, entry_hash: 'aa'.repeat(32), prev_hash: 'cc'.repeat(32),
      visible: false, // out of this org's scope
    },
  ];
}

const verification = { valid: true, length: 2, head: 'ee'.repeat(32), first_invalid_seq: null };
const actor = { person_id: ME, org_id: ORG, org_role: 'manager' };

describe('buildRecordExport', () => {
  const build = (over = {}) => buildRecordExport({
    projectId: PROJECT, projectName: 'Casa Silva', rows: rows(),
    verification, generatedAt: '2026-10-01T09:00:00.000Z', actor, ...over,
  });

  test('header carries project, actor, format and the verification report', () => {
    const a = build().export;
    assert.equal(a.artefact, 'record_export');
    assert.equal(a.format, 'json');
    assert.equal(a.format_version, EXPORT_FORMAT_VERSION);
    assert.equal(a.project_id, PROJECT);
    assert.equal(a.project_name, 'Casa Silva');
    assert.equal(a.generated_at, '2026-10-01T09:00:00.000Z');
    assert.deepEqual(a.generated_by, { person_id: ME, org_id: ORG, org_role: 'manager' });
    assert.equal(a.redaction, 'V7');
    assert.deepEqual(a.verification, verification);
  });

  test('entries are V7-projected in chain order: full keeps payload, redacted is skeletal', () => {
    const { entries } = build();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].seq, 1); // seq ASC — chain order preserved from the rows
    assert.equal(entries[0].redacted, false);
    assert.deepEqual(entries[0].payload, { name: 'Casa' });
    const red = entries[1];
    assert.equal(red.seq, 2);
    assert.equal(red.redacted, true);
    assert.equal(red.payload, undefined);
    assert.equal(red.type, undefined);
    assert.equal(red.entry_hash, 'aa'.repeat(32)); // hash survives so the chain reads end to end
  });

  test('counts reflect the projection', () => {
    const a = build().export;
    assert.equal(a.entry_count, 2);
    assert.equal(a.redacted_count, 1);
  });

  test('empty ledger → zero entries, still a valid self-proving header', () => {
    const a = build({ rows: [], verification: { valid: true, length: 0, head: null, first_invalid_seq: null } });
    assert.equal(a.export.entry_count, 0);
    assert.equal(a.export.redacted_count, 0);
    assert.deepEqual(a.entries, []);
    assert.equal(a.export.verification.head, null);
  });

  test('null project name and null actor ids degrade cleanly', () => {
    const a = build({ projectName: null, actor: { person_id: null, org_id: null, org_role: null } }).export;
    assert.equal(a.project_name, null);
    assert.deepEqual(a.generated_by, { person_id: null, org_id: null, org_role: null });
  });
});

describe('exportFileName', () => {
  test('is the date only, no colons', () => {
    assert.equal(exportFileName({ generatedAt: '2026-10-01T09:00:00.000Z' }), 'record-export-2026-10-01.json');
  });
});
