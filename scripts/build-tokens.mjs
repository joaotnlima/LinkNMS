#!/usr/bin/env node
// Build CSS custom properties (and a flat JSON) from tokens/tokens.json.
// Zero dependencies on purpose — `npm run tokens` works before any install.
// When you outgrow this, swap it for Style Dictionary / Terrazzo without
// touching the token source (see DESIGN-SYSTEM.md).

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SRC = path.join(ROOT, "tokens/tokens.json");
// Emitted next to the brand-book so it opens straight from disk, and into build/ for the app.
const TARGETS = [
  path.join(ROOT, "cowork/design/brand-book/tokens.css"),
  path.join(ROOT, "build/tokens.css"),
];

const raw = JSON.parse(await fs.readFile(SRC, "utf8"));

// Colours and the font emit bare names (--owner, --sans); other groups are
// namespaced (--size-display, --space-4, --radius-control).
const bare = new Set(["color", "font"]);
const flat = {};
const lines = [];

for (const [group, tokens] of Object.entries(raw)) {
  if (group.startsWith("$")) continue;
  for (const [name, tok] of Object.entries(tokens)) {
    if (!tok || typeof tok !== "object" || tok.$value === undefined) continue;
    const varName = bare.has(group) ? name : `${group}-${name}`;
    const value = Array.isArray(tok.$value)
      ? tok.$value.map((v) => (/\s/.test(v) ? `"${v}"` : v)).join(",")
      : String(tok.$value);
    lines.push(`  --${varName}: ${value};`);
    flat[varName] = value;
  }
}

const css =
  `/* GENERATED from tokens/tokens.json by scripts/build-tokens.mjs — do not edit by hand. */\n` +
  `:root {\n${lines.join("\n")}\n}\n`;

for (const out of TARGETS) {
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, css);
}
await fs.writeFile(
  path.join(ROOT, "build/tokens.json"),
  JSON.stringify(flat, null, 2) + "\n",
);

console.log(`tokens → ${Object.keys(flat).length} vars written to:\n  ${TARGETS.join("\n  ")}\n  build/tokens.json`);
