// DWG / DXF previews (PRD-06 V-11..V-17) — pure rules.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeSvg, svgSize, svgHasGeometry, normalizeConversion, previewKey, previewBody,
} from './preview.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 520"><path id="dwg-object-3" d="M 0,0 L 1,1"/></svg>';

describe('SVG hygiene', () => {
  test('scripts, foreignObject, handlers and external hrefs are stripped; #refs stay', () => {
    const dirty = `<svg viewBox="0 0 10 10" onload="x()"><script>alert(1)</script><foreignObject><div/></foreignObject>`
      + `<a href="javascript:alert(1)"><path d="M0 0" onclick='y()'/></a><use xlink:href="#symbol-1F"/><use href="https://evil/x.svg#a"/></svg>`;
    const clean = sanitizeSvg(dirty);
    assert.doesNotMatch(clean, /script|foreignObject|onload|onclick|javascript|evil/i);
    assert.match(clean, /xlink:href="#symbol-1F"/);
  });

  test('size from the viewBox; geometry detection', () => {
    assert.deepEqual(svgSize(SVG), { width: 800, height: 520 });
    assert.deepEqual(svgSize('<svg width="1"/>'), { width: null, height: null });
    assert.equal(svgHasGeometry(SVG), true);
    assert.equal(svgHasGeometry('<svg viewBox="0 0 1 1"><defs/></svg>'), false);
  });
});

describe('normalising a converter answer', () => {
  test('ready: layouts named and sized, layers checked, warnings kept', () => {
    const out = normalizeConversion({
      ok: true,
      layouts: [{ name: ' Model ', svg: SVG }, { name: '', svg: SVG }, { name: 'empty', svg: '<svg/>' }],
      layers: [{ name: 'A-ROOF', on: true, color: '#E6E9EE', count: 42 }, { name: 'X-XREF', on: false, color: 'red' }, { on: true }],
      warnings: [{ code: 'xref_missing', detail: 'X-XREF-SITE' }, { detail: 'no code' }],
    });
    assert.equal(out.status, 'ready');
    assert.deepEqual(out.layouts.map((l) => [l.name, l.width, l.height]), [['Model', 800, 520], ['Layout 2', 800, 520]]);
    assert.deepEqual(out.layers, [{ name: 'A-ROOF', on: true, color: '#e6e9ee', count: 42 }, { name: 'X-XREF', on: false }]);
    assert.deepEqual(out.warnings, [{ code: 'xref_missing', detail: 'X-XREF-SITE' }]);
  });

  test('failures carry a known reason; nothing drawable is empty_drawing (V-14)', () => {
    assert.equal(normalizeConversion({ ok: false, reason: 'converter_not_configured' }).reason, 'converter_not_configured');
    assert.equal(normalizeConversion({ ok: false, reason: 'segfault' }).reason, 'conversion_failed');
    assert.equal(normalizeConversion(null).reason, 'conversion_failed');
    assert.equal(normalizeConversion({ ok: true, layouts: [{ name: 'M', svg: '<svg/>' }] }).reason, 'empty_drawing');
  });
});

describe('derived objects and the wire', () => {
  test('a preview layout has its own key under the document, keyed by the bytes', () => {
    assert.equal(previewKey({ documentId: 'd', sha256: 'ab', index: 1 }), 'v2/documents/d/previews/ab/1.svg');
  });

  test('previewBody: as-is types are ready, unconverted pending, failures unavailable with reason', () => {
    const base = { documentId: 'd', versionNo: 2 };
    assert.equal(previewBody({ ...base, fileType: 'pdf', converted: false }).status, 'ready');
    assert.equal(previewBody({ ...base, fileType: 'dwg', converted: true, preview: null }).status, 'pending');
    const failed = previewBody({ ...base, fileType: 'dwg', converted: true, preview: { status: 'unavailable', reason: 'unsupported_version' } });
    assert.deepEqual([failed.status, failed.reason], ['unavailable', 'unsupported_version']);
    const ready = previewBody({
      ...base, fileType: 'dxf', converted: true,
      preview: { status: 'ready', layers: [{ name: '0', on: true }], warnings: [] },
      layouts: [{ layout_index: 0, name: 'Model', width: 800, height: null, view_url: 'u', expires_at: 't' }],
    });
    assert.deepEqual(ready.layouts, [{ index: 0, name: 'Model', width: 800, view_url: 'u', expires_at: 't' }]);
    assert.deepEqual(ready.layers, [{ name: '0', on: true }]);
  });
});
