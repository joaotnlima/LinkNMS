// Unit tests for the PRD-05 task-files wire → view transforms.
//
// Pinned: the tab label says "n to review" before a count (F-1); reference rows
// are reference links + attached files, filtered by type with DXF under DWG
// (F-3); "also on / deliverable of" names other tasks only (F-3); the preview
// state words (F-7); a submitted deliverable shows its version, state labels and
// x-of-n (F-2, F-16); the 100 MB cap and the accepted types (F-6, D-49); and a
// matching project file is offered as "new version of X" by name stem and type
// only (F-8).
//
// Run: node --test src/lib/v2/task-files-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toFileView, referenceFiles, filterCounts, usedElsewhere, previewOf, toDeliverablesView, filesTabLabel,
  uploadRefusal, matchingFile, fileTypeOfName, deliverableStateByDocument, MAX_UPLOAD_BYTES,
} from './task-files-view.ts';

const SHA = 'a'.repeat(64);
const doc = (over = {}) => ({
  id: 'd1', project_id: 'p', scope_type: 'project', scope_id: 'p', kind: 'drawing', title: 'A-301 Roof plan',
  file_type: 'pdf', preview_status: 'ready', current_version: 2,
  versions: [
    { version_no: 1, mime: 'application/pdf', size_bytes: 1, sha256: SHA, uploaded_by: { person_id: 'x', org_id: 'o1' }, uploaded_at: '2027-01-01T10:00:00Z' },
    { version_no: 2, mime: 'application/pdf', size_bytes: 1, sha256: SHA, uploaded_by: { person_id: 'x', org_id: 'o2' }, uploaded_at: '2027-01-08T10:00:00Z', note: 'gutter moved' },
  ],
  used_on: [{ task_id: 't', role: 'reference', inherited: false }, { task_id: 't2', role: 'reference', inherited: true }, { task_id: 't3', role: 'deliverable', inherited: false }],
  role: 'reference', inherited: false, attached: false,
  ...over,
});

test('a file row: newest version, note, uploader, download of that version', () => {
  const f = toFileView(doc());
  assert.equal(f.versionLabel, 'v2');
  assert.equal(f.latestNote, 'gutter moved');
  assert.equal(f.uploaderOrgId, 'o2');
  assert.equal(f.downloadPath, '/api/v2/document-versions/d1.2:download');
  assert.equal(f.tag, 'PDF');
});

test('reference section: links + attached, by type, DXF with DWG', () => {
  const files = [
    toFileView(doc()),
    toFileView(doc({ id: 'd2', file_type: 'dxf' })),
    toFileView(doc({ id: 'd3', file_type: 'dwg', role: 'deliverable' })),
    toFileView(doc({ id: 'd4', file_type: 'image', role: undefined, attached: true })),
  ];
  assert.deepEqual(referenceFiles(files).map((f) => f.id), ['d1', 'd2', 'd4']);
  assert.deepEqual(referenceFiles(files, 'dwg').map((f) => f.id), ['d2']);
  assert.deepEqual(filterCounts(files), { all: 3, pdf: 1, dwg: 1, ifc: 0, image: 1 });
});

test('where else a file is used names the other tasks', () => {
  const names = new Map([['t2', '2.5.1 Structure prep'], ['t3', '1.4 Structural design']]);
  assert.equal(usedElsewhere(toFileView(doc()), 't', (id) => names.get(id) ?? null),
    'deliverable of 1.4 Structural design · also on 2.5.1 Structure prep');
  assert.equal(usedElsewhere(toFileView(doc({ used_on: [{ task_id: 't', role: 'reference', inherited: false }] })), 't', () => null), null);
});

test('preview words (F-7)', () => {
  assert.deepEqual(previewOf('pending'), { label: 'Making preview…', tone: 'pending' });
  assert.deepEqual(previewOf('unavailable'), { label: 'No preview, download only', tone: 'warn' });
  assert.equal(previewOf('ready').tone, 'ok');
});

test('deliverables: x of n, submitted version label, decision trail', () => {
  const sub = (seq, status, over = {}) => ({
    id: `s${seq}`, seq, document_id: 'd1', version_no: seq, sha256: SHA, file_title: 'S-110.pdf', mime: 'application/pdf',
    submitted_by: { person_id: 'p', org_id: 'sub' }, submitted_at: '2027-01-08T10:00:00Z', status, ...over,
  });
  const v = toDeliverablesView({
    task_id: 't', required_count: 2, approved_count: 1, done_blocked: true, to_review_count: 1,
    can_edit: true, can_submit: false, can_review: true,
    items: [
      { id: 'a', project_id: 'p', task_id: 't', title: 'S-110', required: true, due: null, source_rfp_id: 'r', status: 'submitted',
        current: sub(2, 'submitted'), history: [sub(2, 'submitted'), sub(1, 'changes_requested', { decision: { by: { person_id: 'm', org_id: 'gc' }, at: 'x', comment: 'pitch' } })],
        can_decide: true },
      { id: 'b', project_id: 'p', task_id: 't', title: 'Calc', required: true, due: '2027-02-01', source_rfp_id: null, status: 'approved',
        current: sub(1, 'approved', { decision: { by: { person_id: 'm', org_id: 'owner' }, at: 'y' } }), history: [] },
    ],
  });
  assert.equal(v.progressLabel, '1 of 2 approved');
  assert.equal(v.progressPct, 50);
  assert.equal(v.items[0].stateLabel, 'v2 submitted · review');
  assert.equal(v.items[0].fromRfp, true);
  assert.equal(v.items[0].earlier[0].decisionComment, 'pitch');
  assert.equal(v.items[0].current.fileType, 'pdf');
  assert.equal(v.items[1].stateLabel, '✓ Approved');
  assert.equal(v.items[1].canDecide, false);
});

test('tab label: "n to review" wins over the count (F-1)', () => {
  assert.equal(filesTabLabel(8, 2), '2 to review');
  assert.equal(filesTabLabel(8, 0), '8');
  assert.equal(filesTabLabel(null, 0), null);
});

test('uploads: 100 MB, PDF/DWG/DXF/IFC/images only (F-6, D-49)', () => {
  assert.equal(uploadRefusal({ name: 'a.pdf', size: MAX_UPLOAD_BYTES }), null);
  assert.match(uploadRefusal({ name: 'a.pdf', size: MAX_UPLOAD_BYTES + 1 }), /100 MB/);
  assert.match(uploadRefusal({ name: 'notes.docx', size: 10 }), /only PDF/);
  assert.equal(uploadRefusal({ name: 'IMG_0001', size: 10, type: 'image/heic' }), null);
  assert.equal(fileTypeOfName('casa-rev-d.IFC'), 'ifc');
});

test('new version of X is offered on the same stem and type only (F-8)', () => {
  const files = [toFileView(doc({ id: 'roof', title: 'roof-details.dwg', file_type: 'dwg' })), toFileView(doc())];
  assert.equal(matchingFile(files, 'Roof Details.dwg')?.id, 'roof');
  assert.equal(matchingFile(files, 'roof-details.pdf'), null);
  assert.equal(matchingFile(files, 'A-301 Roof plan.pdf')?.id, 'd1');
});

test('project page: deliverable state per document', () => {
  const m = deliverableStateByDocument([
    { id: 'a', status: 'approved', current: { document_id: 'd1' } },
    { id: 'b', status: 'not_yet' },
  ]);
  assert.equal(m.get('d1'), 'approved');
  assert.equal(m.size, 1);
});
