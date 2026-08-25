---
specVersion: "0.3.0"
brand: ../../../BRAND.md
surface: LinkNMS marketing site
---

# LinkNMS — Marketing Site

## Overview

The surface is the public landing site: the first contact for a homeowner or
a builder who has already been burned by "he said / she said" and is deciding
whether LinkNMS is the neutral ground it claims to be. Its job is to make the
promise legible and credible in one scroll — *everyone argues from the
record, not from memory* — without a single line that a disappointed builder
could read back to us six months later.

This is a different expression of the same identity than the web app. The app
is a dense workstation; the site is a calm, confident explainer. It keeps the
brand's engineering-drawing calm — warm paper, precise lines, data as proof —
but opens it up: more whitespace, larger type, and the two-sides motif
(planned vs. actual, owner vs. builder) used as the organising idea of the
page. It persuades by showing the record, not by hyping it. No fear-selling:
the dispute is named soberly, never dramatised.

**The scroll is editorial and full-viewport.** Each section is a single
statement on a full paper canvas: a giant display headline in the hero, then
"reveal" screens where the House Record mark (and the planned-vs-actual bars)
float as the object, flanked by an uppercase heading and mixed-case body,
separated only by hairline dashed dividers — the museum-artifact treatment,
rendered in Paper/Ink with Owner Blue and Builder Orange rather than in a dark
theme.

**Mobile-first, like the product.** The people who most need LinkNMS —
contractors and owners mid-build — arrive on a phone, often from a WhatsApp
link. The single-column phone layout is the primary target; wider screens add
breathing room, not new content.

## Logo & marks

The logo is the **"House Record" mark** — a house whose roof is split at the
ridge into Owner Blue and Builder Orange, over the paper record holding the
planned (blue) and actual (orange) bars. The icon *is* the logo; the wordmark
and slogan are added only where the surface needs them.

- **The lockup** — the mark + `LinkNMS` (exact casing) with the **"Trust
  built-in."** slogan beneath, set two-tone (**Trust** in Ink, *built-in.* in
  the fade grey `#9a9a9a`), echoing the record's tonal fade. Used consistently
  in **both the header and the footer** — same lockup, same weight.
- **Assets, never redrawn** — SVG masters in [`../logos`](../logos), and
  rasters/favicon/OG in [`../brand-kit`](../brand-kit). The page wires
  `favicon.ico`, an SVG favicon, `apple-touch-icon` (180 px) and the social
  `og-image`.
- **Misuse** — never recolour or merge the two roof halves, never add shadow,
  gradient or outline to the mark, and never bake the wordmark into the icon
  asset. Full rules live in the brand-book (`../brand-book`).

## Colors

The same four brand primitives, mirrored at exact values. The marketing
surface leans harder on the Owner Blue / Builder Orange pairing as narrative,
but still as marks and accents on Paper, never as full decorative fields.

| Role | Brand color | Value | Origin |
|---|---|---|---|
| `primary` | Owner Blue | `#2a78d6` | Mirrored |
| `secondary` | Builder Orange | `#eb6834` | Mirrored |
| `foreground` | Ink | `#0b0b0b` | Mirrored |
| `surface` | Paper | `#fcfcfb` | Mirrored |
| `surface-sunken` | Paper | `#f4f3f0` | Derived from Paper |
| `outline` | Ink | `#dcdbd7` | Derived from Ink on Paper |
| `muted-foreground` | Ink | `#5b5b58` | Derived from Ink |
| `primary-muted` | Owner Blue | `#e2edfb` | Derived from Owner Blue |
| `secondary-muted` | Builder Orange | `#fce3d8` | Derived from Builder Orange |
| `fade` | Ink | `#9a9a9a` | Derived — the slogan's "built-in." tone |

The planned/actual encoding carries into any product illustration or diagram
on the page: Owner Blue for the agreed/planned side, Builder Orange for the
actual/on-site side, always with a label so the pairing reads without colour.
No semantic success/danger palette is introduced here — the site is not a
status surface.

## Typography

Same system sans stack as the brand and the app
(`system-ui, -apple-system, "Segoe UI", sans-serif`). A separate, more
expressive scale is derived for reading at a distance and for persuasive
hierarchy — larger than the app's dense scale, but the same neutral,
document-like face.

| Token | Size / line-height (base → lg) | Weight | Role |
|---|---|---|---|
| `hero` | 34 / 40 → 56 / 60 px | 700 | Hero headline |
| `section` | 26 / 32 → 34 / 40 px | 600 | Section headlines |
| `subhead` | 18 / 26 → 20 / 28 px | 600 | Sub-headlines, feature titles |
| `lede` | 18 / 28 px | 400 | Intro paragraphs, hero support |
| `body` | 16 / 26 px | 400 | Default prose |
| `data` | 16 / 24 px | 500, tabular-nums | Figures inside product illustrations |
| `caption` | 13 / 18 px | 400 | Footnotes, legal, source labels |

Body copy is 16 px minimum for comfortable phone reading. No display or brand
typeface is licensed or introduced — the neutrality is the point on this
surface too.

## Layout

**Full-viewport editorial scroll.** Every section is full-bleed (100 vw) and at
least 100 vh — one statement per screen, on a single Paper canvas throughout.
The concept is desktop-editorial and stacks gracefully to one column on phones.
Breakpoints: `base` (< 640 px), `md` (≥ 768 px), `lg` (≥ 1024 px).

- **Hero** — a giant display headline (uppercase, `line-height 0.9`, the
  sculptural stacking), a lede, one primary CTA, and a lower-left info-card that
  states the tamper-evident boundary with the *Trust built-in.* slogan.
- **Reveal sections** — a three-column grid (heading / object / body): the
  House Record mark floats centred as the "object" (or the planned-vs-actual
  bars), a left-aligned uppercase heading and a right-aligned mixed-case body at
  generous gutters. Stacks to one column at `base`, object first.
- **Dividers** — 1 px dashed `outline` hairlines are the only breaks between
  sections; no alternating bands, no boxes.
- **Furniture** — a fixed, paper-tinted nav (logo lockup + four items, a dashed
  underline following the active section via scrollspy) and a vertical serial
  label down the right edge ("LinkNMS · one record").
- 4 px base unit; spacing steps `4, 8, 12, 16, 24, 32, 48, 64`. Generous quiet
  space is the point — each screen breathes.
- The two-sides motif still governs the object: Owner Blue for planned/agreed,
  Builder Orange for actual/on-site, always labelled so it reads without colour.

## Elevation & Depth

Flat and paper-like, matching the brand. The page is mostly unshadowed.

- One soft shadow token, reserved for a floating element only: the sticky
  header on scroll and any product screenshot lifted off the band —
  `0 1px 2px rgba(11,11,11,0.06), 0 8px 24px rgba(11,11,11,0.08)`.
- The only permitted gradient is a functional progress fill shown inside a
  product illustration (a budget or timeline bar). No decorative gradients,
  glows, or glass.

## Shapes

- Corner radius: `8 px` for cards, inputs, and product screenshots; `999 px`
  (pill) only for the primary CTA button; `0` for figures inside a product
  illustration, which stay crisp and drawing-like.
- Borders are `1 px` `outline`; section bands are separated by background
  tone, not rules, except a single hairline above the footer.

## Components

Mobile-first throughout — 44 × 44 px minimum touch target, nothing essential
behind hover.

- **Site header** — the logo lockup (mark + `LinkNMS` + the *Trust built-in.*
  slogan) left, a single `primary` CTA right. Collapses to lockup + CTA + menu
  button at `base`; becomes a slim sticky bar with the shadow token on scroll.
- **Hero** — `hero` headline carrying the promise, one `lede` line of
  support, a single primary CTA, and a restrained product illustration
  showing the planned/actual split. No carousel, no autoplay, no counters
  claiming adoption that isn't substantiated.
- **CTA button** — pill, filled Owner Blue (`primary`), one primary per view;
  a secondary text-link variant for "See how it works". Full-width at `base`,
  auto-width from `md`, 48 px tall.
- **Feature block** — `subhead` title, `body` copy, and a small supporting
  figure or icon. Grid of one column at `base`, two or three at `lg`. Each
  maps to a message pillar (one shared record; every change accountable;
  honest about what it proves).
- **"What it is / what it isn't" split** — the honesty section rendered as
  the two-column device: a plain list of what LinkNMS is beside an equally
  plain list of what it is not (not tamper-proof, not a BIM authoring suite,
  not a permitting integration, not an ERP). This section is a feature of the
  brand, not fine print — it is given real space.
- **FAQ / disclosure** — accordion of plain questions; the tamper-evident
  boundary is stated in full in at least one answer, never buried.
- **Lead form** — waitlist or contact. Label-above fields, 2–3 fields
  maximum, `primary` focus ring, honest button copy ("Join the waitlist",
  not "Get started" if nothing ships yet).
- **Footer** — the same logo lockup (mark + `LinkNMS` + the *Trust built-in.*
  slogan, two-tone), navigation, and any legal/claims text in `caption`. Draft
  or unsubstantiated claims never appear here as fact.

## Do's and Don'ts

- **Do** design the phone layout first; every section must read and convert
  one-handed at `base`.
- **Do** give the "what it isn't" honesty its own real estate — it is a trust
  builder, not a disclaimer to hide.
- **Do** address owner and builder as equals in the same copy; never frame the
  site as one party's tool against the other.
- **Do** keep the Owner Blue / Builder Orange pairing labelled wherever it
  encodes planned vs. actual, so it reads without colour.
- **Don't** use "tamper-proof", "unhackable", or "bulletproof" anywhere. The
  only approved term is **tamper-evident**.
- **Don't** state unbuilt capability, uptime, customer counts, or "used by
  builders" as fact — those are draft claims until substantiated.
- **Don't** fear-sell: name the dispute soberly, don't dramatise it with
  alarm imagery or countdown pressure.
- **Don't** add decorative gradients, glass, stock-photo gloss, or hype
  adjectives; the credibility comes from clarity, like the record itself.
