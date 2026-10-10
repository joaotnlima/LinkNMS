// DwgConverter adapters (PRD-06, D-49) without LibreDWG installed: the CLI is
// a fake `run`, so these prove the calls we make and how answers map — not
// LibreDWG itself (its flags are checked against its usage text, see the adapter).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import {
  createNoopDwgConverter, createLibreDwgConverter, selectDwgConverter, layersFromJson, tagLayers, reasonOf,
} from './dwg-converters.mjs';

const MODEL = '<svg viewBox="0 0 10 10"><path id="dwg-object-7" d="M 0,0 L 1,1"/></svg>';
const PAPER = '<svg viewBox="0 0 420 297"><path id="dwg-object-9" d="M 0,0 L 1,1"/></svg>';
const JSON_TREE = {
  OBJECTS: [
    { object: 'LAYER', index: 2, handle: [0, 1, 16], name: 'A-ROOF', color: { index: 7 }, flag: 0 },
    { object: 'LAYER', index: 3, handle: [0, 1, 17], name: 'A-PATT', color: { index: -8 }, flag: 0 },
    { entity: 'LINE', index: 7, handle: [0, 1, 40], layer: [5, 1, 16, 16] },
    { entity: 'LINE', index: 9, handle: [0, 1, 41], layer: [5, 1, 17, 17] },
  ],
};

function fakeRun(calls, { fail = null } = {}) {
  return async (bin, args) => {
    calls.push([bin, ...args]);
    if (fail && bin.endsWith(fail.bin)) throw fail.err;
    if (bin.endsWith('dwg2SVG')) return { stdout: args[0] === '--mspace' ? MODEL : PAPER, stderr: '' };
    if (bin.endsWith('dwgread')) {
      await writeFile(args[args.indexOf('-o') + 1], JSON.stringify(JSON_TREE));
      return { stdout: '', stderr: '' };
    }
    if (bin.endsWith('dxf2dwg')) {
      const out = args[args.indexOf('-o') + 1];
      await writeFile(out, await readFile(args.at(-1)));
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected ${bin}`);
  };
}

describe('adapter selection', () => {
  test('the default converts nothing and says why (V-14)', async () => {
    const c = selectDwgConverter({});
    assert.equal(c.name, 'none');
    assert.deepEqual(await c.convert({ bytes: Buffer.from('x'), fileType: 'dwg' }), { ok: false, reason: 'converter_not_configured' });
    assert.equal(createNoopDwgConverter().name, 'none');
    assert.equal(selectDwgConverter({ DWG_CONVERTER: 'LibreDWG' }).name, 'libredwg');
  });
});

describe('LibreDWG adapter (fake CLI)', () => {
  test('DWG: model + paper space SVGs, layers from dwgread JSON, elements tagged with their layer', async () => {
    const calls = [];
    const c = createLibreDwgConverter({ binDir: '/opt/libredwg/bin', run: fakeRun(calls) });
    const out = await c.convert({ bytes: Buffer.from('AC1032'), fileType: 'dwg' });
    assert.equal(out.ok, true);
    assert.deepEqual(out.layouts.map((l) => l.name), ['Model', 'Paper space']);
    assert.match(out.layouts[0].svg, /id="dwg-object-7" data-layer="A-ROOF"/);
    assert.deepEqual(out.layers, [
      { name: 'A-ROOF', on: true, count: 1, color: '#e6e9ee' },
      { name: 'A-PATT', on: false, count: 1, color: '#808080' },
    ]);
    assert.deepEqual(calls.map((c2) => [c2[0], c2[1]]), [
      ['/opt/libredwg/bin/dwg2SVG', '--mspace'], ['/opt/libredwg/bin/dwg2SVG', calls[1][1]], ['/opt/libredwg/bin/dwgread', '-O'],
    ]);
  });

  test('DXF goes through dxf2dwg first (V-17)', async () => {
    const calls = [];
    const out = await createLibreDwgConverter({ run: fakeRun(calls) }).convert({ bytes: Buffer.from('0\nSECTION'), fileType: 'dxf' });
    assert.equal(out.ok, true);
    assert.equal(calls[0][0], 'dxf2dwg');
    assert.deepEqual(calls[0].slice(1, 3), ['-y', '-o']);
  });

  test('failures map to reasons; a broken layer read is a warning, not a failure', async () => {
    const version = Object.assign(new Error('exit 1'), { code: 1, stderr: 'ERROR: This version is not supported' });
    const res = await createLibreDwgConverter({ run: fakeRun([], { fail: { bin: 'dwg2SVG', err: version } }) })
      .convert({ bytes: Buffer.from('x'), fileType: 'dwg' });
    assert.deepEqual(res, { ok: false, reason: 'unsupported_version' });
    assert.equal(reasonOf({ killed: true, signal: 'SIGTERM' }), 'conversion_timeout');
    assert.equal(reasonOf({ code: 'ENOENT' }), 'converter_not_configured');
    assert.equal(reasonOf({ code: 2, stderr: 'boom' }), 'conversion_failed');

    const noLayers = await createLibreDwgConverter({ run: fakeRun([], { fail: { bin: 'dwgread', err: new Error('x') } }) })
      .convert({ bytes: Buffer.from('x'), fileType: 'dwg' });
    assert.equal(noLayers.ok, true);
    assert.deepEqual(noLayers.layers, []);
    assert.equal(noLayers.warnings[0].code, 'layers_unavailable');
  });

  test('layer tagging escapes names and leaves unknown entities alone', () => {
    const { layerOf } = layersFromJson({ OBJECTS: [{ object: 'LAYER', handle: [0, 5], name: 'A"<B' }, { entity: 'ARC', index: 1, layer: [5, 5] }] });
    assert.equal(tagLayers('<path id="dwg-object-1"/><path id="dwg-object-2"/>', layerOf),
      '<path id="dwg-object-1" data-layer="A&quot;&lt;B"/><path id="dwg-object-2"/>');
  });
});
