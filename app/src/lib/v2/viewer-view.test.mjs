// Unit tests for the drawing viewer's wire → view arithmetic (PRD-06).
//
// Pinned: AC1 markups stay pinned to their page; AC2 an uncalibrated measure
// shows no units, and after calibrating on the 11 400 mm dimension the same
// dimension reads 11.40 m; a revised drawing needs its own calibration; the
// footer says what saving does (V-3); the version picker labels "markups only";
// the overlay base skips markups-only versions (V-7); the rail groups by type
// (V-1); the failure reason reads as a sentence (V-14); hidden layers are CSS.
//
// Run: node --test src/lib/v2/viewer-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toMarkupView, draftMarkup, draftBody, markupsOnSheet, sheetScale, measureLabel, ratioLabel, distance,
  versionOptions, overlayBase, saveFooter, railGroups, previewReason, hiddenLayersCss, cloudPath, isViewable,
} from './viewer-view.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const shaOf = (map) => (no) => map[no] ?? null;

const wire = (over = {}) => ({
  id: 'm1', document_id: 'd', version_no: 2, page_or_layout: '1', kind: 'cloud',
  geometry: { points: [[10, 10], [60, 40]] }, text: 'Skylight width', author: { person_id: 'p', org_id: 'o' },
  created_at: '2027-01-05T10:00:00Z', state: 'open', ...over,
});

test('AC1: a 4-sheet PDF — markups stay on their page; later versions do not leak back', () => {
  const all = [
    toMarkupView(wire({ id: 'a', page_or_layout: '1' })),
    toMarkupView(wire({ id: 'b', page_or_layout: '3', version_no: 3 })),
    toMarkupView(wire({ id: 'c', page_or_layout: '3', version_no: 4 })),
    draftMarkup({ id: 'd', kind: 'text', page: '3', points: [[5, 5]], text: 'note' }),
  ];
  const on3 = markupsOnSheet(all, { page: '3', versionNo: 3, shaOf: shaOf({ 2: A, 3: A, 4: A }) });
  assert.deepEqual(on3.map((m) => [m.id, m.n]), [['b', 1], ['d', 2]]);
  assert.deepEqual(markupsOnSheet(all, { page: '1', versionNo: 3, shaOf: shaOf({ 2: A, 3: A }) }).map((m) => m.id), ['a']);
});

test('V-10: a markup drawn on different bytes is flagged with its version', () => {
  const all = [toMarkupView(wire({ id: 'old', version_no: 1 }))];
  const [m] = markupsOnSheet(all, { page: '1', versionNo: 3, shaOf: shaOf({ 1: A, 2: A, 3: B }) });
  assert.equal(m.fromVersion, 1);
  const [same] = markupsOnSheet(all, { page: '1', versionNo: 2, shaOf: shaOf({ 1: A, 2: A }) });
  assert.equal(same.fromVersion, null);
});

test('AC2: no units before calibration; 11 400 mm calibration → the dimension reads 11.40 m (±1%)', () => {
  const dim = [[90, 420], [550, 420]];
  assert.equal(measureLabel(dim, null), 'not calibrated');
  const cal = draftMarkup({ id: 'k', kind: 'calibration', page: '1', points: dim, lengthMm: 11400 });
  const scale = sheetScale([cal], { page: '1', versionNo: 2, shaOf: shaOf({ 2: A }) });
  assert.equal(measureLabel(dim, scale), '11.40 m');
  // a slightly different pick of the same line still reads within 1%
  const mm = distance([[91, 420], [548, 421]]) * scale;
  assert.ok(Math.abs(mm - 11400) / 11400 < 0.01);
  assert.equal(measureLabel([[0, 0], [20, 0]], scale), '496 mm');
  assert.equal(ratioLabel(scale, 'pdf'), '1:70');
  assert.equal(ratioLabel(scale, 'dwg'), null);
});

test('a calibration applies to the same bytes only, and per page', () => {
  const saved = toMarkupView(wire({ id: 'k', kind: 'calibration', version_no: 2, geometry: { points: [[0, 0], [100, 0]], length_mm: 5000 } }));
  delete saved.text;
  assert.equal(sheetScale([saved], { page: '1', versionNo: 3, shaOf: shaOf({ 2: A, 3: A }) }), 50, 'markups-only v3 keeps it');
  assert.equal(sheetScale([saved], { page: '1', versionNo: 4, shaOf: shaOf({ 2: A, 4: B }) }), null, 'a revised drawing is calibrated again');
  assert.equal(sheetScale([saved], { page: '2', versionNo: 3, shaOf: shaOf({ 2: A, 3: A }) }), null);
});

test('a draft becomes the wire MarkupDraft', () => {
  assert.deepEqual(draftBody(draftMarkup({ id: 'k', kind: 'calibration', page: '2', points: [[0, 0], [1, 0]], lengthMm: 900 })),
    { id: 'k', page_or_layout: '2', kind: 'calibration', geometry: { points: [[0, 0], [1, 0]], length_mm: 900 } });
  assert.deepEqual(draftBody(draftMarkup({ id: 'a', kind: 'arrow', page: '1', points: [[0, 0], [1, 1]], text: ' Ø100? ' })),
    { id: 'a', page_or_layout: '1', kind: 'arrow', geometry: { points: [[0, 0], [1, 1]] }, text: 'Ø100?' });
});

test('V-2 / V-3 / V-7: version picker, footer sentence, overlay base', () => {
  const versions = [
    { version_no: 1, sha256: A, change_kind: 'upload' },
    { version_no: 2, sha256: B, change_kind: 'upload' },
    { version_no: 3, sha256: B, change_kind: 'markup_only' },
  ];
  assert.deepEqual(versionOptions(versions, 3).map((v) => v.label), ['v3 · markups only · current', 'v2', 'v1']);
  assert.equal(saveFooter(2, 1, 'pdf'), '1 unsaved markup · saving makes v3 = same PDF + markups (the history labels it “markups only”)');
  assert.match(saveFooter(2, 0, 'dwg'), /^No unsaved markups · saving makes v3 = same \.dwg/);
  assert.equal(overlayBase(versions, 3), 1, 'v2 has the same bytes as v3 — compare with v1');
  assert.equal(overlayBase(versions, 1), null);
});

test('V-1 rail groups, V-14 reasons, V-12 hidden layers, cloud geometry', () => {
  const f = (id, fileType) => ({ id, fileType });
  assert.deepEqual(railGroups([f('a', 'ifc'), f('b', 'pdf'), f('c', 'dxf'), f('d', 'image')]).map((g) => [g.key, g.files.map((x) => x.id)]),
    [['pdf', ['b']], ['dwg', ['c']], ['ifc', ['a']], ['other', ['d']]]);
  assert.equal(isViewable(f('x', 'dxf')), true);
  assert.equal(isViewable(f('x', 'ifc')), false);
  assert.match(previewReason('unsupported_version'), /not supported/);
  assert.equal(previewReason('odd_case'), 'odd case');
  assert.equal(previewReason(null), null);
  assert.equal(hiddenLayersCss(['A-PATT', 'X"Y'], (s) => s.replace(/"/g, '\\"')), '[data-layer="A-PATT"]{display:none}\n[data-layer="X\\"Y"]{display:none}');
  assert.match(cloudPath([[0, 0], [40, 20]], 5), /^M 0 0( A [\d.]+ [\d.]+ 0 0 1 [\d.]+ [\d.]+)+ Z$/);
});
