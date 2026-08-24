# 08 — Brand

This document owns the **elected logo and the brand-kit**: what the mark
is, how it is built, and which asset to use where. It sits between two
neighbours and does not repeat them:

- [`BRAND.md`](../../BRAND.md) (repo root) owns the *meaning* — strategy,
  voice, the two-sides visual system, and governance/misuse rules.
- The per-surface `DESIGN.md` files own *application* — tokens, layout and
  components for the [web app](../design/web-app/DESIGN.md) and the
  [marketing site](../design/marketing-site/DESIGN.md).

For a browsable version — logo, palette, type, lockups and live
components on one page — open the **[brand-book](../design/brand-book/index.html)**
(`cowork/design/brand-book/index.html`).

## The elected logo — "House Record"

The chosen mark is a **house whose roof is split at the ridge** into
Owner Blue (left slope) and Builder Orange (right slope), sitting above a
paper body — the record — that holds two bars: a longer **planned** bar
(blue) and a shorter **actual** bar (orange).

It says the whole idea in one shape: the two sides of a build, side by
side, over the shared record of planned vs. actual. It is drawn in the
brand's engineering-drawing register — flat colour, thin ink outline, no
gradient or shadow — so it reads like a mark stamped on a document, not a
campaign logo.

It descends from two earlier explorations that were combined: the
house-at-the-ridge split, and the planned-vs-actual timeline bars.

## The logo is the mark

**The icon is the logo.** The wordmark *LinkNMS* and the slogan are
*added* only where a surface needs them; each context decides whether to
show the name and in which arrangement. Three sanctioned forms:

| Form | When |
|---|---|
| **Icon only** | app icon, favicon, avatar, anywhere the name is already present |
| **Horizontal lockup** — icon + name (+ slogan) side by side | headers, nav, signatures |
| **Stacked lockup** — icon above name (+ slogan) | covers, footers, narrow/centred spaces |

Never bake the wordmark into the icon asset itself — the `brand-kit/icon/`
files carry **no text**.

## Slogan

**Trust built-in.** — a double reading: trust designed *in*, and built
like a house. Set two-tone: **Trust** in Ink (solid), **built-in.** in a
faded grey (`#9a9a9a` on light, `#8c8c8c` on dark), echoing the tonal
fade of the record.

## Colours

The four mandatory brand primitives, unchanged:

| Role | Name | Value |
|---|---|---|
| Planned / Owner side | **Owner Blue** | `#2a78d6` |
| Actual / Builder side | **Builder Orange** | `#eb6834` |
| Text / marks | **Ink** | `#0b0b0b` |
| Surface | **Paper** | `#fcfcfb` |

Owner Blue and Builder Orange are the signature pair and must never be the
*only* thing distinguishing one party or planned-from-actual — always pair
colour with a label or position (inherited accessibility commitment).

## Typeface

The brand's **system-sans stack** —
`system-ui, -apple-system, "Segoe UI", sans-serif`. No display or brand
face is licensed; the neutral, universally-available face keeps the mark
feeling like a document. The wordmark is set medium-to-bold, exact casing
**LinkNMS**.

## Clear space & misuse

- Keep clear space around the lockup equal to the height of the "L".
- Don't recolour the split outside the two identity colours; don't add
  shadow, gradient, glow or outline; don't stretch, rotate or re-case the
  wordmark; don't merge the two roof halves into one flat colour (that
  erases the whole idea).
- Monochrome fallback: Ink on Paper (or reversed) — the split then reads as
  a tonal division. Never place the mark so small that the split stops
  reading, nor on a busy photographic background.
- **Status:** current working identity, not a registered trademark — no
  ™/® and no partner/co-branded lockups are approved.

## The brand-kit

Assets live under [`cowork/design/`](../design/README.md):

```
logos/            SVG masters (single source, editable, colour, light+dark)
  icon.svg · icon-dark.svg
  logo-horizontal.svg · logo-horizontal-dark.svg
  logo-stacked.svg · logo-stacked-dark.svg

brand-kit/        ready-to-use exports (no colour-SVG duplication)
  icon/             the mark only, no text — PNG 16–1024, webp, favicon, mono
  logo-horizontal/  PNG 800/400w + mono
  logo-stacked/     PNG 800/400w + mono
  social/           og-image · twitter-header · github-social-preview
```

| Need | Use |
|---|---|
| App icon, favicon, avatar | `brand-kit/icon/` (or `logos/icon.svg`) |
| Header / nav lockup | `logos/logo-horizontal.svg` or `brand-kit/logo-horizontal/` |
| Cover / footer / narrow | `logos/logo-stacked.svg` or `brand-kit/logo-stacked/` |
| Single-colour / print | the `*-mono-black.svg` / `*-mono-white.svg` in each folder |
| Social share images | `brand-kit/social/` |

The colour vector masters live once in `logos/`; `brand-kit/` holds only
derived formats. The SVG masters use the brand's system-sans stack, so they
render correctly without bundling a font.
