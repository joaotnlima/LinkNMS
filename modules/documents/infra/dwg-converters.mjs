// DwgConverter adapters (PRD-06 V-11, V-17; D-49) — the port is documented in
// application/dwg-preview.mjs. Selected by env at the composition root:
//
//   DWG_CONVERTER     unset | 'none'  → createNoopDwgConverter (the DEFAULT):
//                                        every DWG/DXF becomes `unavailable`,
//                                        reason `converter_not_configured`.
//                     'libredwg'      → createLibreDwgConverter.
//   LIBREDWG_BIN_DIR  directory holding dwg2SVG, dwgread, dxf2dwg (else PATH).
//   DWG_CONVERT_TIMEOUT_MS            per CLI call (default 60 000).
//
// LibreDWG is GPL-3.0. It is NOT installed by this repo (no image, no package):
// it runs as a separate executable, invoked through execFile, and its
// deployment waits for the legal check D-49 asks for (to-be/08 §Documents).
//
// CLI calls (checked against LibreDWG's programs/*.c usage text, master, 2026-10):
//   dwg2SVG [--mspace] DWGFILE          → SVG on stdout (paper space when the
//                                          drawing has one, else model space;
//                                          --mspace forces model space). Every
//                                          element carries id="dwg-object-<index>".
//   dwgread -O JSON -o OUT.json DWGFILE → the object tree (LAYER objects, and
//                                          entities with their layer handle).
//   dxf2dwg -y -o OUT.dwg DXFFILE        → DXF to DWG, so DXF takes the same path.
// NOT verified by running: the JSON shape of handle references (we read the
// last number of an array as the absolute handle) and the layer `off` / `flag`
// fields. Both only feed the layer list; if they do not parse, the preview
// still renders and the layer list is simply empty.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_STDOUT = 64 * 1024 * 1024;

export function createNoopDwgConverter() {
  return {
    name: 'none',
    async convert() {
      return { ok: false, reason: 'converter_not_configured' };
    },
  };
}

/** Pick the adapter from env (the composition root passes process.env). */
export function selectDwgConverter(env = {}) {
  const which = String(env.DWG_CONVERTER ?? 'none').trim().toLowerCase();
  if (which === 'libredwg') {
    return createLibreDwgConverter({
      binDir: env.LIBREDWG_BIN_DIR || null,
      timeoutMs: Number(env.DWG_CONVERT_TIMEOUT_MS) > 0 ? Number(env.DWG_CONVERT_TIMEOUT_MS) : 60_000,
    });
  }
  return createNoopDwgConverter();
}

/**
 * @param {{ binDir?: string|null, timeoutMs?: number, run?: Function }} opts
 *   `run(bin, args, {timeoutMs}) → {stdout, stderr}` is injectable for tests;
 *   the default is execFile (no shell — file names never reach a shell).
 */
export function createLibreDwgConverter({ binDir = null, timeoutMs = 60_000, run = runCli } = {}) {
  const bin = (name) => (binDir ? join(binDir, name) : name);
  return {
    name: 'libredwg',
    async convert({ bytes, fileType }) {
      const dir = await mkdtemp(join(tmpdir(), 'lnms-dwg-'));
      try {
        let dwg = join(dir, 'in.dwg');
        if (fileType === 'dxf') {
          const dxf = join(dir, 'in.dxf');
          await writeFile(dxf, bytes);
          await run(bin('dxf2dwg'), ['-y', '-o', dwg, dxf], { timeoutMs });
        } else {
          await writeFile(dwg, bytes);
        }
        const model = await run(bin('dwg2SVG'), ['--mspace', dwg], { timeoutMs });
        const sheet = await run(bin('dwg2SVG'), [dwg], { timeoutMs });
        let layers = [];
        let layerOf = new Map();
        const warnings = [];
        try {
          const out = join(dir, 'out.json');
          await run(bin('dwgread'), ['-O', 'JSON', '-o', out, dwg], { timeoutMs });
          ({ layers, layerOf } = layersFromJson(JSON.parse(await readFile(out, 'utf8'))));
        } catch {
          warnings.push({ code: 'layers_unavailable', detail: 'the layer list could not be read from this file' });
        }
        const layouts = [{ name: 'Model', svg: tagLayers(model.stdout, layerOf) }];
        if (sheet.stdout.trim() && sheet.stdout !== model.stdout) {
          layouts.push({ name: 'Paper space', svg: tagLayers(sheet.stdout, layerOf) });
        }
        if (/unknown font|font .*not found|substitut/i.test(`${model.stderr}\n${sheet.stderr}`)) {
          warnings.push({ code: 'fonts_substituted', detail: 'some text uses fonts that are not available; it may shift slightly' });
        }
        if (/xref/i.test(`${model.stderr}\n${sheet.stderr}`)) {
          warnings.push({ code: 'xref_missing', detail: 'external references are not part of the file and are not shown' });
        }
        return { ok: true, layouts, layers, warnings };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

function runCli(file, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: MAX_STDOUT, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout, stderr });
    });
  });
}

/** Map a CLI failure to a preview reason (V-14 "with the reason when known"). */
export function reasonOf(err) {
  if (err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') return 'conversion_timeout';
  if (err?.code === 'ENOENT') return 'converter_not_configured';
  if (/version|not supported|unsupported/i.test(String(err?.stderr ?? ''))) return 'unsupported_version';
  return 'conversion_failed';
}

const ACI = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 7: '#e6e9ee', 8: '#808080', 9: '#c0c0c0' };

function lastNumber(ref) {
  if (Array.isArray(ref)) {
    for (let i = ref.length - 1; i >= 0; i -= 1) if (Number.isInteger(ref[i])) return ref[i];
  }
  return Number.isInteger(ref) ? ref : null;
}

/**
 * Layers and entity → layer from `dwgread -O JSON` output: LAYER objects
 * (name, colour, off/frozen), entities by `index` with their `layer` handle.
 */
export function layersFromJson(json) {
  const objects = Array.isArray(json?.OBJECTS) ? json.OBJECTS : [];
  const byHandle = new Map();
  for (const o of objects) {
    if (o?.object !== 'LAYER' || typeof o.name !== 'string') continue;
    const handle = lastNumber(o.handle);
    const colorIndex = typeof o.color === 'object' && o.color ? o.color.index : o.color;
    const off = o.off === 1 || o.off === true || (Number.isInteger(o.flag) && (o.flag & 1) === 1)
      || (Number.isInteger(colorIndex) && colorIndex < 0);
    byHandle.set(handle, {
      name: o.name, on: !off, count: 0,
      ...(ACI[Math.abs(colorIndex)] ? { color: ACI[Math.abs(colorIndex)] } : {}),
    });
  }
  const layerOf = new Map();
  for (const o of objects) {
    if (!o?.entity || !Number.isInteger(o.index)) continue;
    const layer = byHandle.get(lastNumber(o.layer));
    if (!layer) continue;
    layer.count += 1;
    layerOf.set(o.index, layer.name);
  }
  return { layers: [...byHandle.values()], layerOf };
}

function escapeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Tag every `id="dwg-object-N"` element with `data-layer="…"` so the viewer can hide a layer (V-12). */
export function tagLayers(svg, layerOf) {
  if (!layerOf?.size) return svg;
  return String(svg).replace(/id="dwg-object-(\d+)"/g, (m, n) => {
    const name = layerOf.get(Number(n));
    return name ? `${m} data-layer="${escapeAttr(name)}"` : m;
  });
}
