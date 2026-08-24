#!/usr/bin/env node
// Build CSS custom properties from tokens.json — the single source of truth.
// Zero dependencies on purpose — `npm run tokens` works before any install.
// Emits the same tokens.css to every consumer so there is one source.
// When you outgrow this, swap it for Style Dictionary / Terrazzo without
// touching the token source (see README.md).

import fs from "node:fs/promises";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(HERE, "tokens.json");
const TARGETS = [
  path.join(ROOT, "cowork/design/brand-book/tokens.css"), // interim static brand-book
  path.join(ROOT, "brand-book/src/styles/tokens.css"), // Storybook (live on Vercel)
];

const raw = JSON.parse(await fs.readFile(SRC, "utf8"));

// Colours and the font emit bare names (--owner, --sans); other groups are
// namespaced (--size-display, --space-4, --radius-control).
const bare = new Set(["color", "font"]);
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
  }
}

const css =
  `/* GENERATED from design-system/tokens.json by design-system/build-tokens.mjs — do not edit by hand. */\n` +
  `:root {\n${lines.join("\n")}\n}\n`;

for (const out of TARGETS) {
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, css);
}

console.log(`tokens → ${lines.length} vars written to:\n  ${TARGETS.map((t) => path.relative(ROOT, t)).join("\n  ")}`);
