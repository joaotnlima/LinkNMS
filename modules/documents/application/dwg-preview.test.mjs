// The DWG/DXF conversion job (PRD-06 V-11, V-14, V-17) with an in-memory store:
// only converted types run, a throwing converter is a result (never a stuck
// outbox), and a ready conversion writes one derived object per layout.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { convertVersionPreview } from './dwg-preview.mjs';
import { createInMemoryObjectStorage } from '../infra/storage.mjs';

function memoryStore(fileName, sha = 'a'.repeat(64)) {
  const saved = [];
  return {
    saved,
    mirrored: 0,
    async getDocument() { return { id: 'd', current_version: 1 }; },
    async getVersion() { return { storage_key: `v2/documents/d/v1-r/${fileName}`, mime: 'application/octet-stream', sha256: sha }; },
    async getPreview() { return saved[0] ?? null; },
    async mirrorPreviewStatus() { this.mirrored += 1; },
    async savePreview(row) { saved.push(row); return row; },
  };
}

const quiet = { error() {} };

describe('convertVersionPreview', () => {
  test('PDFs and images are not converted', async () => {
    const store = memoryStore('A-301.pdf');
    const converter = { name: 'x', convert: async () => assert.fail('must not run') };
    assert.equal(await convertVersionPreview({ store, storage: createInMemoryObjectStorage(), converter, documentId: 'd', versionNo: 1 }), 'skipped');
  });

  test('a throwing converter becomes unavailable / conversion_failed; the job does not throw', async () => {
    const store = memoryStore('detail.dxf');
    const storage = createInMemoryObjectStorage();
    await storage.put({ key: 'v2/documents/d/v1-r/detail.dxf', body: Buffer.from('0\nSECTION') });
    const converter = { name: 'boom', convert: async () => { throw new Error('segfault'); } };
    assert.equal(await convertVersionPreview({ store, storage, converter, documentId: 'd', versionNo: 1, log: quiet }), 'unavailable');
    assert.deepEqual([store.saved[0].status, store.saved[0].reason, store.saved[0].converter], ['unavailable', 'conversion_failed', 'boom']);
    // A replay finds the preview and only re-mirrors.
    assert.equal(await convertVersionPreview({ store, storage, converter, documentId: 'd', versionNo: 1, log: quiet }), 'reused');
    assert.equal(store.mirrored, 1);
  });

  test('ready: each layout is sanitised and written under its own key', async () => {
    const store = memoryStore('roof.dwg');
    const storage = createInMemoryObjectStorage();
    await storage.put({ key: 'v2/documents/d/v1-r/roof.dwg', body: Buffer.from('AC1032') });
    const converter = {
      name: 'fake',
      convert: async () => ({ ok: true, layouts: [{ name: 'Model', svg: '<svg viewBox="0 0 4 3"><script>x</script><line x1="0"/></svg>' }] }),
    };
    assert.equal(await convertVersionPreview({ store, storage, converter, documentId: 'd', versionNo: 1 }), 'ready');
    const [layout] = store.saved[0].layouts;
    assert.equal(layout.storageKey, `v2/documents/d/previews/${'a'.repeat(64)}/0.svg`);
    assert.deepEqual([layout.width, layout.height], [4, 3]);
    assert.doesNotMatch(String(storage._objects.get(layout.storageKey).body), /script/);
  });
});
