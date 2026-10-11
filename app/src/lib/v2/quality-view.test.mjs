// PRD-12 N-3, N-4: the quality page's cards, the raise form and inspections.
// Run: node --test src/lib/v2/quality-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ncCard, raiseBody, parseChecklist, inspectionRow, photoHref } from './quality-view.ts';

const names = {
  orgs: new Map([['R', 'Atelier Inspeção'], ['S', 'Canalizações Lda']]),
  tasks: new Map([['T', 'Impermeabilização WC']]),
  locations: new Map([['L', 'Piso 1 — WC']]),
};

test('a card names where, who raised it, who fixes it and what the server lets me do', () => {
  const card = ncCard({
    id: 'n', project_id: 'p', task_id: 'T', location_id: 'L', kind: 'safety', severity: 'major',
    description: 'Fuga na base de duche', photo_document_ids: ['d'], raised_by: { org_id: 'R' },
    assigned_to_org_id: 'S', status: 'fixed', last_note: 'Refeito', raised_at: '2026-10-10T08:00:00Z', actions: ['close', 'reject_fix'],
  }, names);
  assert.equal(card.where, 'Piso 1 — WC · Impermeabilização WC');
  assert.equal(card.raisedBy, 'Atelier Inspeção');
  assert.equal(card.assignedTo, 'Canalizações Lda');
  assert.equal(card.statusLabel, 'Fixed — waiting for the raiser to close it');
  assert.deepEqual(card.actions, ['close', 'reject_fix']);
  assert.equal(card.photos[0].href, photoHref('d'));
  assert.equal(card.raisedOn, '2026-10-10');
  const bare = ncCard({ id: 'n', project_id: 'p', kind: 'quality', severity: 'minor', description: 'x', photo_document_ids: [], raised_by: { org_id: 'Z' }, status: 'open' }, names);
  assert.equal(bare.where, null);
  assert.deepEqual(bare.actions, []);
});

test('raise: description and severity required; optional fields only when set', () => {
  assert.equal(raiseBody({ description: ' ', severity: 'major', kind: 'quality', taskId: '', locationId: '', assignedToOrgId: '', photoDocumentIds: [] }, 'i').ok, false);
  assert.equal(raiseBody({ description: 'x', severity: '', kind: 'quality', taskId: '', locationId: '', assignedToOrgId: '', photoDocumentIds: [] }, 'i').ok, false);
  const ok = raiseBody({ description: ' Fissura ', severity: 'critical', kind: 'safety', taskId: '', locationId: 'L', assignedToOrgId: '', photoDocumentIds: ['d'] }, 'i');
  assert.deepEqual(ok, { ok: true, body: { id: 'i', description: 'Fissura', severity: 'critical', kind: 'safety', location_id: 'L', photo_document_ids: ['d'] } });
});

test('checklist lines: x / ✗ / no: mark a failed item', () => {
  assert.deepEqual(parseChecklist('Andaimes\nx Guarda-corpos\n✓ EPIs\n\nno: Extintor'), [
    { item: 'Andaimes', ok: true }, { item: 'Guarda-corpos', ok: false }, { item: 'EPIs', ok: true }, { item: 'Extintor', ok: false },
  ]);
});

test('inspection row: passed / failed and where it was', () => {
  const row = inspectionRow({ id: 'i', kind: 'quality', date: '2026-10-10', checklist: [{ item: 'a', ok: true }, { item: 'b', ok: false }], task_ids: ['T'], location_ids: ['L'], inspector_org_id: 'R' }, names);
  assert.deepEqual([row.passed, row.failed, row.failedItems, row.where, row.inspector], [1, 1, ['b'], ['Piso 1 — WC', 'Impermeabilização WC'], 'Atelier Inspeção']);
});
