import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  fileTypeOf, initialPreviewStatus, defaultKindFor, validateVersionMeta, linkRows, usesBody,
} from './files.mjs';
import { validateFile, documentBody, MAX_UPLOAD_BYTES } from './model.mjs';

const SHA = 'a'.repeat(64);

describe('file type (PRD-05 F-3 tags)', () => {
  test('the name decides first — DWG and IFC carry no agreed mime', () => {
    assert.equal(fileTypeOf('A-301 Roof plan.PDF', 'application/octet-stream'), 'pdf');
    assert.equal(fileTypeOf('roof-details.dwg', 'application/octet-stream'), 'dwg');
    assert.equal(fileTypeOf('site.dxf', ''), 'dxf');
    assert.equal(fileTypeOf('casa-rev-c.ifc', 'model/ifc'), 'ifc');
    assert.equal(fileTypeOf('membrane.jpeg', ''), 'image');
  });

  test('the mime decides when the name has no known extension', () => {
    assert.equal(fileTypeOf('scan', 'application/pdf'), 'pdf');
    assert.equal(fileTypeOf('drawing', 'image/vnd.dwg'), 'dwg');
    assert.equal(fileTypeOf('photo', 'image/png'), 'image');
    assert.equal(fileTypeOf('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'other');
  });
});

describe('preview state (F-7) and kind', () => {
  test('a DWG waits for its conversion; everything else is ready', () => {
    assert.equal(initialPreviewStatus('dwg'), 'pending');
    assert.equal(initialPreviewStatus('dxf'), 'pending', 'PRD-06 V-17: DXF takes the DWG pipeline');
    for (const t of ['pdf', 'ifc', 'image', 'other']) assert.equal(initialPreviewStatus(t), 'ready');
  });

  test('drawings keep kind drawing and rely on mime (PRD-05 §5)', () => {
    assert.equal(defaultKindFor('pdf'), 'drawing');
    assert.equal(defaultKindFor('dwg'), 'drawing');
    assert.equal(defaultKindFor('ifc'), 'bim');
    assert.equal(defaultKindFor('image'), 'photo');
  });
});

describe('upload cap (D-49)', () => {
  test('100 MB for every kind', () => {
    assert.equal(MAX_UPLOAD_BYTES, 100 * 1024 * 1024);
    const ok = { name: 'a.pdf', mime: 'application/pdf', size_bytes: MAX_UPLOAD_BYTES, sha256: SHA };
    assert.deepEqual(validateFile(ok), {});
    assert.ok(validateFile({ ...ok, size_bytes: MAX_UPLOAD_BYTES + 1 })['file.size_bytes']);
  });
});

describe('version metadata', () => {
  test('defaults to an upload without note', () => {
    assert.deepEqual(validateVersionMeta({}), { errors: {}, meta: { note: null, baseVersionNo: null, changeKind: 'upload' } });
  });

  test('carries note, base and kind; names bad fields', () => {
    const ok = validateVersionMeta({ note: ' spacing 600 ', base_version_no: 2, change_kind: 'edit' });
    assert.deepEqual(ok.meta, { note: 'spacing 600', baseVersionNo: 2, changeKind: 'edit' });
    // PRD-06: new bytes are never "markups only" — saveDocumentMarkups appends that version.
    assert.ok(validateVersionMeta({ change_kind: 'markup_only' }).errors.change_kind);
    const bad = validateVersionMeta({ note: 'x'.repeat(2001), base_version_no: 0, change_kind: 'rewrite' });
    assert.deepEqual(Object.keys(bad.errors).sort(), ['base_version_no', 'change_kind', 'note']);
  });
});

describe('links', () => {
  test('the task, then every sub-task as inherited (F-10)', () => {
    const rows = linkRows({ taskId: 't', role: 'reference', includeSubtasks: true, descendantIds: ['a', 'b', 't'] });
    assert.deepEqual(rows, [
      { taskId: 't', role: 'reference', inherited: false, inheritedFromTaskId: null },
      { taskId: 'a', role: 'reference', inherited: true, inheritedFromTaskId: 't' },
      { taskId: 'b', role: 'reference', inherited: true, inheritedFromTaskId: 't' },
    ]);
    assert.equal(linkRows({ taskId: 't', role: 'deliverable', includeSubtasks: false, descendantIds: ['a'] }).length, 1);
  });

  test('used_on is task, role and inherited', () => {
    assert.deepEqual(usesBody([{ task_id: 'x', role: 'deliverable', inherited: false, document_id: 'd' }]),
      [{ task_id: 'x', role: 'deliverable', inherited: false }]);
  });
});

describe('wire body (PRD-05 fields)', () => {
  test('file type from the newest version, preview status, version note', () => {
    const body = documentBody(
      { id: 'd', project_id: 'p', scope_type: 'project', scope_id: 'p', kind: 'drawing', title: 'Roof', share_with_ancestors: false, current_version: 2, preview_status: 'pending' },
      [
        { version_no: 1, mime: 'application/pdf', size_bytes: 1, sha256: SHA, storage_key: 'v2/documents/d/v1-r/roof.pdf', uploaded_by_person_id: 'p', uploaded_by_org_id: 'o', uploaded_at: 'x' },
        { version_no: 2, mime: 'application/octet-stream', size_bytes: 1, sha256: SHA, storage_key: 'v2/documents/d/v2-r/roof.dwg', uploaded_by_person_id: 'p', uploaded_by_org_id: 'o', uploaded_at: 'y', note: 'v2', change_kind: 'upload' },
      ],
    );
    assert.equal(body.project_id, 'p');
    assert.equal(body.file_type, 'dwg');
    assert.equal(body.preview_status, 'pending');
    assert.equal(body.versions[1].note, 'v2');
    assert.equal(body.versions[0].change_kind, 'upload');
    assert.equal('note' in body.versions[0], false);
  });
});
