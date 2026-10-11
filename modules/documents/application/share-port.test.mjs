// The share-files port (PRD-12 N-12): only the build's shared files, current
// version, never an organisation-private one or another build's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createShareFilesPort } from './share-port.mjs';

const P = 'p1';
const docs = {
  a: { id: 'a', project_id: P, scope_type: 'project', kind: 'drawing', title: 'Plantas', current_version: 2 },
  t: { id: 't', project_id: P, scope_type: 'task', kind: 'photo', title: 'Foto', current_version: 1 },
  priv: { id: 'priv', project_id: P, scope_type: 'project', kind: 'other', title: 'Export', current_version: 1, private_to_org_id: 'o' },
  c: { id: 'c', project_id: P, scope_type: 'contract', kind: 'contract_doc', title: 'Contrato', current_version: 1 },
  other: { id: 'other', project_id: 'p2', scope_type: 'project', kind: 'spec', title: 'X', current_version: 1 },
  reserved: { id: 'reserved', project_id: P, scope_type: 'project', kind: 'spec', title: 'Y', current_version: 0 },
};
const store = {
  async getDocument(id) { return docs[id] ?? null; },
  async getVersion(id, n) {
    return { document_id: id, version_no: n, storage_key: `v2/documents/${id}/${n}/file.pdf`, mime: 'application/pdf', size_bytes: '10', sha256: 'f'.repeat(64), uploaded_at: new Date('2026-10-01T00:00:00Z') };
  },
};
const signed = [];
const storage = { async signDownload(args) { signed.push(args); return { url: `https://r2/${args.key}` }; } };

test('shareableFiles keeps only live, shared, proven files of the build, in order', async () => {
  const port = createShareFilesPort(store, storage);
  const files = await port.shareableFiles(P, ['t', 'priv', 'a', 'c', 'other', 'reserved', 'nope', 'a']);
  assert.deepEqual(files.map((f) => f.document_id), ['t', 'a']);
  assert.equal(files[1].version_no, 2);
  assert.equal(files[1].file_type, 'pdf');
  assert.equal(files[1].size_bytes, 10);
  assert.equal(files[1].uploaded_at, '2026-10-01T00:00:00.000Z');
});

test('signSharedDownload: the current version, inline on request; null for anything else', async () => {
  const port = createShareFilesPort(store, storage);
  const res = await port.signSharedDownload(P, 'a', { disposition: 'inline' });
  assert.equal(res.url, 'https://r2/v2/documents/a/2/file.pdf');
  assert.deepEqual(signed.at(-1), { key: 'v2/documents/a/2/file.pdf', fileName: 'Plantas.pdf', disposition: 'inline' });
  assert.equal(await port.signSharedDownload(P, 'priv'), null);
  assert.equal(await port.signSharedDownload(P, 'other'), null);
});
