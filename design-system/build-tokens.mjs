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

// `dark: true` also emits the `color-dark` group inside a prefers-color-scheme
// block. The brand-book is deliberately light-only: it renders every swatch
// beside its printed hex, so repainting it with the OS preference would make
// the captions lie. The portal is the surface that actually has a dark scheme.
const TARGETS = [
  { file: path.join(ROOT, "cowork/design/brand-book/tokens.css"), dark: false }, // interim static brand-book
  { file: path.join(ROOT, "brand-book/src/styles/tokens.css"), dark: false }, // Storybook (live on Vercel)
  { file: path.join(ROOT, "app/src/app/tokens.css"), dark: true }, // the portal (LINA-92)
];

const raw = JSON.parse(await fs.readFile(SRC, "utf8"));

// Colours and the font emit bare names (--owner, --sans); other groups are
// namespaced (--size-display, --space-4, --radius-control). `color-dark` is not
// a namespace — it re-binds the SAME names under a media query.
const bare = new Set(["color", "font"]);
const DARK_GROUP = "color-dark";

const declare = (group, name, tok) => {
  const varName = bare.has(group) ? name : `${group}-${name}`;
  const value = Array.isArray(tok.$value)
    ? tok.$value.map((v) => (/\s/.test(v) ? `"${v}"` : v)).join(",")
    : String(tok.$value);
  return `--${varName}: ${value};`;
};

const isToken = (tok) => tok && typeof tok === "object" && tok.$value !== undefined;

const lines = [];
const darkLines = [];

for (const [group, tokens] of Object.entries(raw)) {
  if (group.startsWith("$")) continue;
  for (const [name, tok] of Object.entries(tokens)) {
    if (!isToken(tok)) continue;
    if (group === DARK_GROUP) darkLines.push(`    ${declare("color", name, tok)}`);
    else lines.push(`  ${declare(group, name, tok)}`);
  }
}

/* ---------- scheme parity check (LINA-92) ----------
   A variable that exists only in the dark block is the drift this pipeline was
   built to stop: it silently resolves to nothing in light mode, so the bug only
   shows up for whoever has a dark OS. Hard-fail on it. The reverse (a light
   token with no dark counterpart) is legitimate for genuinely scheme-specific
   tokens, which are listed explicitly rather than pattern-matched. */
const LIGHT_ONLY = new Set([
  "fade", // landing slogan; the landing has its own stylesheet and no dark scheme
  "fade-dark", // already the dark variant of `fade` — the scheme is baked into the name
  "plan-baseline-on-dark", // the -on-dark rungs ARE the dark values, and in the dark
  "plan-actual-on-dark", // block they are bound to the plain plan-* names. Repeating
  "plan-closed-on-dark", // them under color-dark would be a second source of truth.
  // The landing palette (LINA-108). It lives on the marketing site, which has no
  // dark scheme, so every `lp-*` is scheme-specific by nature — the portal never
  // reads these, and giving them a color-dark twin would model a scheme they do
  // not have.
  "lp-ink",
  "lp-ink-70",
  "lp-ink-60",
  "lp-ink-40",
  "lp-ink-hair",
  "lp-cream",
  "lp-cream-60",
  "lp-cream-40",
  "lp-cream-20",
  "lp-cream-hair",
  "lp-stone",
]);

const lightNames = new Set(Object.keys(raw.color ?? {}).filter((k) => isToken(raw.color[k])));
const darkNames = new Set(Object.keys(raw[DARK_GROUP] ?? {}).filter((k) => isToken(raw[DARK_GROUP][k])));

const orphans = [...darkNames].filter((n) => !lightNames.has(n));
if (orphans.length) {
  console.error(
    `tokens: ${orphans.length} token(s) in \`${DARK_GROUP}\` have no counterpart in \`color\`, so they would emit a\n` +
      `dark-only custom property that resolves to nothing in light mode:\n  ${orphans.join("\n  ")}\n` +
      `Add the light value, or fix the name.`,
  );
  process.exit(1);
}

const undarkened = [...lightNames].filter((n) => !darkNames.has(n) && !LIGHT_ONLY.has(n));
if (undarkened.length) {
  console.error(
    `tokens: ${undarkened.length} colour token(s) have no \`${DARK_GROUP}\` value and are not declared\n` +
      `scheme-specific, so the portal would render them with their LIGHT value on a dark\n` +
      `background:\n  ${undarkened.join("\n  ")}\n` +
      `Add a dark value, or add the name to LIGHT_ONLY with a reason.`,
  );
  process.exit(1);
}

/* ---------- emit ---------- */

const HEADER = `/* GENERATED from design-system/tokens.json by design-system/build-tokens.mjs — do not edit by hand. */\n`;
const light = `:root {\n${lines.join("\n")}\n}\n`;
const dark =
  `\n/* The dark scheme re-binds the same names, so consumers write var(--owner)\n` +
  `   once and never branch on the colour scheme. Derived from the re-based\n` +
  `   primitives by LINA-106; every pair is gated by \`npm run contrast\`. */\n` +
  `@media (prefers-color-scheme: dark) {\n  :root {\n${darkLines.join("\n")}\n  }\n}\n`;

for (const { file, dark: wantsDark } of TARGETS) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, HEADER + light + (wantsDark ? dark : ""));
}

console.log(
  `tokens → ${lines.length} vars (+${darkLines.length} dark) written to:\n  ` +
    TARGETS.map((t) => `${path.relative(ROOT, t.file)}${t.dark ? " (light + dark)" : " (light only)"}`).join("\n  "),
);
