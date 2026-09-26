import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateFile, storageKey, versionRef, parseVersionRef, documentBody,
} from './model.mjs';

const SHA = 'a'.repeat(64);

describe('file declaration', () => {
  test('accepts a complete declaration', () => {
    assert.deepEqual(validateFile({ name: 'planta.pdf', mime: 'application/pdf', size_bytes: 1024, sha256: SHA }), {});
  });

  test('names every broken field', () => {
    const errors = validateFile({ name: '', mime: 'pdf', size_bytes: 0, sha256: 'nope' });
    assert.deepEqual(Object.keys(errors).sort(), ['file.mime', 'file.name', 'file.sha256', 'file.size_bytes']);
  });

  test('missing file object is one clear error', () => {
    assert.ok(validateFile(null).file);
  });
});

describe('storage keys and version refs', () => {
  test('key sanitizes the name and scopes by document + version', () => {
    const key = storageKey({ documentId: 'doc-1', versionNo: 3, fileName: 'a b/../c.pdf', random: 'r' });
    assert.equal(key, 'v2/documents/doc-1/v3-r/a_b_.._c.pdf');
    assert.ok(!key.includes(' '));
  });

  test('version ref round-trips and refuses colons (router command split)', () => {
    const id = '018f6f2a-0000-7000-8000-000000000001';
    const ref = versionRef(id, 2);
    assert.ok(!ref.includes(':'));
    assert.deepEqual(parseVersionRef(ref), { documentId: id, versionNo: 2 });
    assert.equal(parseVersionRef('junk'), null);
    assert.equal(parseVersionRef(`${id}:2`), null);
  });
});

describe('wire body', () => {
  test('maps versions with actor and numeric size', () => {
    const body = documentBody(
      { id: 'd', scope_type: 'task', scope_id: 't', kind: 'photo', title: 'Fissura', share_with_ancestors: false, current_version: 1 },
      [{ version_no: 1, mime: 'image/jpeg', size_bytes: '2048', sha256: SHA, uploaded_by_person_id: 'p', uploaded_by_org_id: 'o', uploaded_at: 'now' }],
    );
    assert.equal(body.current_version, 1);
    assert.deepEqual(body.versions[0].uploaded_by, { person_id: 'p', org_id: 'o' });
    assert.equal(body.versions[0].size_bytes, 2048);
  });
});
