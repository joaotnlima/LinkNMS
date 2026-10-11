#!/usr/bin/env node
// Keep public/pdfjs/pdf.worker.min.mjs in lock-step with the installed
// pdfjs-dist (PRD-06 V-4) — the same rule as copy-ifc-wasm.mjs: the PDF viewer
// loads its worker from /pdfjs/ (GlobalWorkerOptions.workerSrc), NOT from
// node_modules, so Next never bundles or traces it. This copy runs on
// `prebuild`, so a pdfjs-dist bump re-copies the matching worker and the
// committed asset can never drift from the library that drives it (pdf.js
// refuses a worker of another version).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const src = join(appRoot, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
const destDir = join(appRoot, 'public', 'pdfjs');
const dest = join(destDir, 'pdf.worker.min.mjs');

try {
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log(`[copy-pdf-worker] ${src} → ${dest}`);
} catch (err) {
  console.error('[copy-pdf-worker] failed:', err?.message ?? err);
  process.exit(1);
}
