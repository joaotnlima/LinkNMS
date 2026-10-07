#!/usr/bin/env node
// Keep public/wasm/web-ifc.wasm in lock-step with the installed web-ifc
// (LINA-409 / doc 24). The viewer loads the WASM from /wasm/ (api.SetWasmPath),
// NOT from node_modules — Next must not try to bundle/trace it — so the asset is
// served from public/. This copy is the single source of truth: it runs on
// `prebuild`, so a `web-ifc` version bump re-copies the matching binary and the
// committed asset can never silently drift from the parser that reads it.
//
// Single-threaded only: the loader uses the non-MT IfcAPI, so we ship
// `web-ifc.wasm` (not `web-ifc-mt.wasm`, which needs COOP/COEP cross-origin
// isolation headers we do not set).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const src = join(appRoot, 'node_modules', 'web-ifc', 'web-ifc.wasm');
const destDir = join(appRoot, 'public', 'wasm');
const dest = join(destDir, 'web-ifc.wasm');

try {
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log(`[copy-ifc-wasm] ${src} → ${dest}`);
} catch (err) {
  console.error('[copy-ifc-wasm] failed:', err?.message ?? err);
  process.exit(1);
}
