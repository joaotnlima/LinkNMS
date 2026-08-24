---
specVersion: "0.3.0"
brand: ../../../BRAND.md
surface: LinkNMS web application
---

# LinkNMS — Web Application

## Overview

The surface is the shared record itself: the workspace where a homeowner, a
contractor and every specialty open the same build and read the same facts —
timeline, budget, scope, and the change history behind them. It is a
working document, not a marketing page, so it inherits LinkNMS's
engineering-drawing calm and turns it into a dense, legible workstation.

The design premise follows directly from the brand's neutral-referee
personality: nothing on screen should read as one party's tool against
another. Planned and actual, owner-side and builder-side, are always
distinguishable — by position and label first, colour second. The interface
behaves like a well-kept logbook that happens to be searchable: quiet
surfaces, precise lines, data as the hero, and no decorative flourish
competing with the record.

**This surface is mobile-first, non-negotiably.** The contractor and the
subcontractor live on the construction site with a phone in hand and will
never open a laptop there — the phone is the only realistic device for the
people entering and checking the record where the work happens. So the phone
layout is the primary design target, not a responsive afterthought: every
core action (log a change, check a budget line, open the history, upload a
photo or model) must be reachable and comfortable one-handed on a small
screen. Desktop is a progressive enhancement for the management and
reporting work that a growing contractor does at a computer — wider
aggregation, side-by-side comparison, dense reports — never a prerequisite
for the on-site record.

**The contractor works across several builds, not one.** A build is the unit
of the record, but the app is multi-build: the same person switches between
their active builds and needs one portfolio view across all of them (budget
health, schedule risk, pending approvals per build). So a **build switcher**
is always within reach, and a **portfolio dashboard** is a first-class
destination — not a feature bolted on for "enterprise". Inside any one build,
the neutral per-build record still governs; the portfolio only aggregates
what the builder is a party to.

## Colors

Four brand primitives are mirrored at their exact approved values and mapped
to roles. All ramps, states, and neutral steps below are derived for this
surface; no approved primitive is altered under its brand meaning.

| Role | Brand color | Value | Origin |
|---|---|---|---|
| `primary` | Owner Blue | `#2a78d6` | Mirrored |
| `secondary` | Builder Orange | `#eb6834` | Mirrored |
| `foreground` | Ink | `#0b0b0b` | Mirrored |
| `surface` | Paper | `#fcfcfb` | Mirrored |
| `surface-sunken` | Paper | `#f4f3f0` | Derived from Paper |
| `surface-raised` | Paper | `#ffffff` | Derived from Paper |
| `outline` | Ink | `#dcdbd7` | Derived from Ink on Paper |
| `outline-strong` | Ink | `#9b9a95` | Derived from Ink on Paper |
| `muted-foreground` | Ink | `#5b5b58` | Derived from Ink |
| `primary-muted` | Owner Blue | `#e2edfb` | Derived from Owner Blue |
| `secondary-muted` | Builder Orange | `#fce3d8` | Derived from Builder Orange |
| `success` | none | `#2e7d54` | Derived (semantic, on-budget/approved) |
| `warning` | none | `#b7791f` | Derived (semantic, needs attention) |
| `danger` | none | `#c0392b` | Derived (semantic, over-budget/blocked) |

**Planned vs. actual is the signature encoding.** `primary` (Owner Blue)
carries the planned / agreed side; `secondary` (Builder Orange) carries the
actual / on-site side. Their muted variants fill timeline and budget bars;
the saturated values are reserved for the bar edge, the active marker, and
labels — colour appears *on* the record, never as a decorative field.

Semantic roles (`success`/`warning`/`danger`) describe budget and status
health only. They never restate the planned/actual distinction — that stays
on the blue/orange axis so the two meanings never collide.

## Typography

One family, mirrored from the brand: the system sans stack
(`system-ui, -apple-system, "Segoe UI", sans-serif`). The scale below is
derived for this surface and does not exist in BRAND.md.

| Token | Size / line-height | Weight | Role |
|---|---|---|---|
| `display` | 28 / 34 px | 600 | Project title, empty-state headings |
| `heading` | 20 / 28 px | 600 | Section headers (Timeline, Budget) |
| `subheading` | 16 / 24 px | 600 | Trade-contract and row-group headers |
| `body` | 14 / 22 px | 400 | Default UI and prose |
| `data` | 14 / 20 px | 500, tabular-nums | Money, dates, deltas, timestamps |
| `caption` | 12 / 16 px | 400 | Metadata, attribution, audit stamps |

All monetary and quantitative values use `data` with tabular figures so
columns align and a changed value reads against its prior value cleanly.
No second display or brand typeface is introduced — the document-like
neutrality is deliberate and inherited.

## Layout

Mobile-first: design and build the phone layout first, then enhance upward.
The breakpoints are `base` (phone, < 640 px — the primary target),
`md` (tablet, ≥ 768 px), and `lg` (desktop, ≥ 1024 px). No view may depend
on a wider breakpoint to be usable; wider ones only add density and
side-by-side context.

- A 4 px base unit; spacing steps `4, 8, 12, 16, 24, 32, 48, 64`. Grid is a
  single column at `base`, widening to a 12-column fluid grid at `lg`.
- **Navigation adapts, never crowds.** At `base`, primary navigation is a
  bottom bar (thumb-reachable) between the core views — Timeline / Budget /
  Scope & History — and trade contracts open from a top drawer; the detail
  view for a change, contract, or attached file (including BIM previews)
  takes the full screen with a back affordance. At `lg`, the same structure
  expands into a persistent left rail (trade contracts and phases), a main
  pane, and a right detail drawer shown side-by-side.
- **One-handed reach.** Primary actions (log a change, approve, upload) sit
  within thumb range at `base` — a bottom-anchored action, not a top-right
  corner. Nothing essential hides behind hover, which does not exist on
  touch.
- Generous quiet space is a first-class rule, not slack: dense data earns its
  room. Reading panes cap at 1200 px on `lg`; at `base` content is full-bleed
  within a 16 px gutter. Tables and timelines scroll horizontally on the
  phone rather than shrinking text below legibility.
- Thin baseline and column rules (`outline`) evoke drawing paper. Rules guide
  the eye between planned and actual rows; they never box content in for
  decoration.

## Elevation & Depth

Depth is minimal and functional — this is paper, not glass.

- `surface` is the base plane. `surface-raised` (`#ffffff`) lifts only
  interactive containers that float above the record: the detail drawer,
  menus, dialogs, and the BIM preview panel.
- One soft shadow token only: `0 1px 2px rgba(11,11,11,0.06), 0 4px 12px
  rgba(11,11,11,0.08)`, used for the drawer and overlays. Cards and table
  rows sit flat, separated by `outline`, not shadow.
- No gradients used as flourish. The only gradient permitted is a functional
  progress fill inside a timeline or budget bar.

## Shapes

- Corner radius: `6 px` for controls, inputs, and cards; `10 px` for the
  drawer and dialogs; `0` for table cells and timeline bars, which stay
  crisp and drawing-like.
- Borders are `1 px` `outline` at rest, `outline-strong` on hover, and the
  relevant party colour (`primary` / `secondary`) on active/selected.
- Planned bars and actual bars share the same height and baseline so a
  variance is read as offset, not as a difference in shape.

## Components

Two layers: the **UI primitives** every screen is assembled from, and the
**record components** specific to LinkNMS. Both inherit the mobile-first rule
— minimum 44 × 44 px touch target, no essential action behind hover.

### UI primitives

- **Button** — three intents: `primary` (filled Owner Blue, one per view, the
  main commit action), `secondary` (outline `outline-strong`, `foreground`
  text), and `danger` (filled `danger`, only for destructive or over-budget
  confirmation). Sizes: `md` 44 px tall (default, the mobile floor) and `lg`
  52 px for the bottom-anchored primary action on `base`. States: rest,
  pressed (no hover on touch — pressed is the felt state), disabled
  (`muted-foreground` on `surface-sunken`), loading (inline spinner, label
  stays). Full-width at `base`, auto-width from `md`.
- **Form field** — label above the control (never placeholder-as-label),
  `outline` border → `primary` on focus → `danger` with a message on error.
  Variants: text, number, `currency` and `date` (both `data`, tabular),
  select, textarea. A 2 px focus ring in `primary` at 40% is always present
  for keyboard and switch users. Forms follow the master-builder rule: a
  **quick form** exposes 2–3 required fields and defers the rest behind
  "Add detail", so a task can be logged in seconds on site.
- **Navigation** — `base`: a bottom tab bar (Timeline / Budget / Scope &
  History), active tab in `primary` with label always shown, plus a top bar
  holding the build switcher and the trade-contract drawer trigger. `lg`: the
  same destinations become the persistent left rail. Never more than five
  primary destinations; overflow goes to a "More" sheet.
- **Build switcher** — a persistent control in the top bar showing the current
  build's name; tapping it opens a list of the contractor's active builds
  (each with a one-glance health dot) plus a link to the portfolio dashboard.
  It is the multi-build anchor: switching build swaps the whole workspace, but
  the current build is always named so nobody edits the wrong record. For a
  single-build owner it degrades to a static title, never dead weight.
- **Portfolio dashboard** — a top-level destination for the contractor: one
  row per build with budget health (`success`/`warning`/`danger` + label),
  schedule status, and a count of pending approvals. Rows are cards at `base`,
  a dense table at `lg`. It aggregates only builds the viewer is a party to,
  and never overrides the neutral per-build record — it links into each build,
  it does not flatten them into one.
- **Card / list row** — the default container for a trade contract, task, or
  attachment. Flat on `surface`, separated by `outline`, `6 px` radius. Whole
  row is one touch target opening its detail; any secondary action is an
  explicit icon button ≥ 44 px, never a hidden swipe-only gesture (swipe may
  be an accelerator, never the only path).
- **Modal / drawer / sheet** — floating containers on `surface-raised` with
  the single shadow token. On `base` they present as a full-height bottom
  sheet with a drag handle and a persistent close; on `lg` as a right drawer
  or centred dialog. One at a time; the primary action sits bottom-anchored
  within thumb reach.
- **Toast** — transient confirmation or error, `surface-raised`, `success`
  or `danger` left marker plus an icon and text (never colour alone).
  Bottom-anchored on `base` so it clears the bottom nav; auto-dismiss for
  confirmations, manual dismiss for errors.
- **Empty state** — a `display` heading, one line of `body` guidance, and a
  single `primary` action. States what to do first, never a dead end; copy
  respects the voice guardrails (no "tamper-proof", no unbuilt feature in the
  present tense).
- **Status badge** — compact state label (e.g. On budget, Over budget,
  Pending approval, Edited). Carries `success`/`warning`/`danger` **and** a
  text label and, where relevant, an icon — colour is never the sole signal.

### Record components

- **Timeline row** — a planned bar (`primary-muted` fill, `primary` edge)
  and an actual bar (`secondary-muted` fill, `secondary` edge) on one
  baseline, each with a text label ("Planned" / "Actual") and its dates in
  `data`. Dependency links draw as thin `outline-strong` connectors.
- **Budget line item** — planned vs. actual columns in `data`, a signed
  delta coloured by `success`/`danger` **and** prefixed with `+`/`−` so the
  sign, not the hue, carries the meaning.
- **Change record** — attribution (`who`), timestamp (`caption`), and a
  before → after value pair. An edited-after-the-fact entry is flagged with
  a visible "edited" marker and icon — tamper-*evident* made literal, never
  hidden.
- **File / BIM attachment** — an upload tile and, where the format allows, an
  inline preview panel on `surface-raised`; every attachment is stamped with
  its uploader and time and linked to the change it documents.
- **Party tag** — labels a row or comment by role using colour **plus** the
  role name and a fixed position; colour alone never identifies a party.

## Do's and Don'ts

- **Do** design and test every core flow on a phone first, one-handed, before
  the desktop layout exists. If a flow only works at `lg`, it is not done.
- **Do** keep touch targets at least 44 × 44 px and place primary on-site
  actions within thumb reach at `base`.
- **Do** distinguish planned/actual and owner/builder by label and position
  first; colour is reinforcement, never the sole channel. *(Inherited
  accessibility commitment — mandatory, may only be raised.)*
- **Do** keep saturated brand colour as marks on the record — bar edges,
  active markers, labels — on a Paper surface.
- **Do** use tabular figures for every value that can change, so a delta is
  legible at a glance.
- **Do** offer a quick 2–3 field version of any create flow, deferring the
  rest — the master builder abandons long forms for WhatsApp.
- **Don't** use "tamper-proof", "unhackable", or "bulletproof" in any UI
  copy, tooltip, or empty state. The only approved term is
  **tamper-evident**.
- **Don't** describe unbuilt capability in the present tense as if it ships;
  BIM preview, uptime, and adoption claims stay out of shipping UI copy until
  substantiated.
- **Don't** style the interface to favour one party — no owner-first or
  builder-first framing, defaults, or visual weight.
- **Don't** add gradients, glows, or shadow as decoration; depth is reserved
  for floating surfaces only.
- **Don't** hide an essential action behind hover, a swipe-only gesture, or a
  desktop-only layout.
