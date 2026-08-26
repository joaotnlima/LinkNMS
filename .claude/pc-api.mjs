#!/usr/bin/env node
// Generic Paperclip API client. Usage:
//   node .claude/pc-api.mjs <METHOD> <path> [jsonBodyFileOrInline]
// Reads PAPERCLIP_API_URL / PAPERCLIP_API_KEY / PAPERCLIP_RUN_ID from env.
import fs from 'node:fs';

const [, , method = 'GET', path = '/', bodyArg] = process.argv;
let base = (process.env.PAPERCLIP_API_URL || '').replace(/\/$/, '');
base = base.replace(/\/api$/, '');
const url = base + path;

let body;
if (bodyArg) {
  if (fs.existsSync(bodyArg)) body = fs.readFileSync(bodyArg, 'utf8');
  else body = bodyArg;
}

const headers = {
  Authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`,
  'Content-Type': 'application/json',
};
if (process.env.PAPERCLIP_RUN_ID) headers['X-Paperclip-Run-Id'] = process.env.PAPERCLIP_RUN_ID;

const res = await fetch(url, { method, headers, body });
const text = await res.text();
console.log(`HTTP ${res.status} ${method} ${path}`);
console.log(text);
