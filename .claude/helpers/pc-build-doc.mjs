#!/usr/bin/env node
// Build a Paperclip document PUT body JSON from a markdown file.
// Usage: node .claude/helpers/pc-build-doc.mjs <title> <mdFile> <outFile> [baseRevisionId]
import { readFile, writeFile } from 'node:fs/promises';
const [, , title, mdFile, outFile, baseRevisionId] = process.argv;
const body = await readFile(mdFile, 'utf8');
const payload = { title, format: 'markdown', body, baseRevisionId: baseRevisionId || null };
await writeFile(outFile, JSON.stringify(payload));
console.log('wrote', outFile, 'bytes', JSON.stringify(payload).length);
