#!/usr/bin/env node
// Paperclip API helper with JSON body read from a file.
// Usage: node .claude/helpers/pc-api-file.mjs <METHOD> <path> <jsonBodyFile>
import { readFile } from 'node:fs/promises';
const base = (process.env.PAPERCLIP_API_URL || '').replace(/\/$/, '').replace(/\/api$/, '');
const key = process.env.PAPERCLIP_API_KEY;
const runId = process.env.PAPERCLIP_RUN_ID;
const [, , method = 'GET', path = '/api/agents/me', bodyFile] = process.argv;
const url = base + (path.startsWith('/') ? path : '/' + path);
const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
if (runId) headers['X-Paperclip-Run-Id'] = runId;
const opts = { method, headers };
if (bodyFile) opts.body = await readFile(bodyFile, 'utf8');
try {
  const res = await fetch(url, opts);
  const text = await res.text();
  console.log(`HTTP ${res.status} ${method} ${path}`);
  console.log(text);
} catch (e) {
  console.error('FETCH_ERROR', e.message);
  process.exit(1);
}
