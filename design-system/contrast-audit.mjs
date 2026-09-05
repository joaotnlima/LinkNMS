#!/usr/bin/env node
// WCAG 2.1 contrast audit for the token set — re-runnable, zero dependencies.
// `npm run contrast` regenerates cowork/design/brand-book/contrast-audit.md.
//
// Why a script and not a spreadsheet: the landing palette (LINA-80) is built on
// translucent cream over photography, so every value has to be composited before
// it can be measured. Doing that by hand is how you ship a 3.1:1 label.

import fs from "node:fs/promises";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "cowork/design/brand-book/contrast-audit.md");
const TOKENS = JSON.parse(await fs.readFile(path.join(HERE, "tokens.json"), "utf8"));

/* ---------- colour maths ---------- */

const hex = (h) => {
  const s = h.replace("#", "");
  const n = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [
    parseInt(n.slice(0, 2), 16),
    parseInt(n.slice(2, 4), 16),
    parseInt(n.slice(4, 6), 16),
    n.length === 8 ? parseInt(n.slice(6, 8), 16) / 255 : 1,
  ];
};

// Source-over composite of fg (possibly translucent) onto an opaque backdrop.
const over = (fg, bg) => {
  const [r, g, b, a] = hex(fg);
  const [br, bg_, bb] = hex(bg);
  return [r * a + br * (1 - a), g * a + bg_ * (1 - a), b * a + bb * (1 - a), 1];
};

const toHex = ([r, g, b]) =>
  "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

const lum = ([r, g, b]) => {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

/* ---------- tokens under audit ----------

   Everything that lives in tokens.json is READ from tokens.json. It used to be
   transcribed here, which meant the audit could keep reporting PASS against
   values the product no longer shipped — an audit that lies is worse than no
   audit. Only two families stay literal: the landing palette (`lp-*`, which
   lives in marketing-site/src/app/landing.css and has no token counterpart) and
   the retired values, which are deliberately frozen historical evidence.
   ------------------------------------------------------------------------- */

const fromTokens = (group) =>
  Object.fromEntries(
    Object.entries(TOKENS[group] ?? {})
      .filter(([, t]) => t && typeof t === "object" && typeof t.$value === "string" && t.$value.startsWith("#"))
      .map(([k, t]) => [k, t.$value]),
  );

const LIGHT = fromTokens("color");
const DARK_TOKENS = fromTokens("color-dark");

const T = {
  // landing palette — lives in landing.css, not in tokens.json
  "lp-ink": "#16181D",
  "lp-cream": "#FBFAF7",
  "lp-cream-60": "#FBFAF799",
  "lp-cream-40": "#FBFAF766",
  "lp-stone": "#EFEDE6",
  white: "#ffffff",

  // Everything in tokens.json's `color` group — the plan semantics, the portal
  // ramp, the ink alpha ramp, the state chips. Read, never transcribed.
  ...LIGHT,

  // retired values, kept so the LINA-46 regression record still measures the
  // thing it was written about. Not shipped anywhere as of LINA-92.
  "owner-retired": "#2a78d6",
  "builder-retired": "#eb6834",
  "success-retired": "#2e7d54",
  "warning-retired": "#b7791f",
  "danger-retired": "#c0392b",
  "ink-retired": "#0b0b0b",
  "paper-retired": "#fcfcfb",
  "muted-retired": "#5b5b58",
  "outline-strong-retired": "#9b9a95",
};

/* Resolve a check operand. A `d:` prefix reads the DARK scheme, which is why
   the dark checks can reuse the same token names — `paper` and `d:paper` are
   the same variable in two schemes, and the whole point of the migration is
   that a consumer writes `var(--paper)` once. An unknown `d:` name is a hard
   error rather than a silent pass-through: a typo there would otherwise be
   measured as the literal string and reported as a comfortable PASS. */
const v = (k) => {
  if (typeof k === "string" && k.startsWith("d:")) {
    const name = k.slice(2);
    if (!(name in DARK_TOKENS)) throw new Error(`contrast: no \`${name}\` in tokens.json color-dark`);
    return DARK_TOKENS[name];
  }
  return T[k] ?? k;
};

// Scrim stops from the spec (§3): #16181d00 → #16181dd9 @55% → #16181df7.
// Probes: the brightest and a mid-grey pixel the photograph can present.
const PHOTO_WHITE = "#ffffff";
const PHOTO_MID = "#808080";

const scrim = (stop, photo) => toHex(over(stop, photo));

/* ---------- the checks ----------

   kind:
     text       — WCAG 1.4.3 body text, 4.5:1. A miss is a blocking AA failure.
     large      — 1.4.3 large text (≥24px, or ≥18.7px @700), 3.0:1. Blocking.
     non-text   — 1.4.11 graphics that carry meaning, 3.0:1. Blocking.
     decorative — redundant ornament next to something that already contrasts.
                  No WCAG floor applies; measured so nobody has to guess later.
     rule       — a pairing that is *supposed* to score badly. It is measured to
                  prove a placement constraint (e.g. "no text above the scrim"),
                  not to be fixed.
     fixed      — the remediated pairing proposed in landing-tokens-decisions.md.
                  These MUST pass, or the fix is not a fix.
     fixed-non-text
                — same contract as `fixed`, but for a graphic rather than type,
                  so the floor is 1.4.11's 3.0:1 instead of 4.5:1. Exists because
                  several ratified fixes (FIX C, FIX E, the budget-bar track) are
                  graphics: filing them as plain `non-text` reported a breakage
                  but let the process still exit 0, so nothing actually gated on
                  them.
------------------------------------------------------------------ */

const MIN = { text: 4.5, large: 3.0, "non-text": 3.0, decorative: 0, rule: 0, fixed: 4.5, "fixed-non-text": 3.0 };
const GATING = new Set(["fixed", "fixed-non-text"]);

const checks = [
  /* --- §1 landing palette on the ink field (hero, scroll sequence, footer) --- */
  ["Landing · on the Ink field", "text", "lp-cream body/heading on lp-ink", "lp-cream", "lp-ink", "Hero lede, headings, nav links."],
  ["Landing · on the Ink field", "text", "lp-cream-60 body on lp-ink", "lp-cream-60", "lp-ink", "Secondary prose."],
  ["Landing · on the Ink field", "text", "lp-cream-40 10–12px label on lp-ink", "lp-cream-40", "lp-ink", "AVAILABLE ON, micro-captions, HUD labels."],
  ["Landing · on the Ink field", "non-text", "lp-cream-40 as a hairline/rule on lp-ink", "lp-cream-40", "lp-ink", "Dashed rule, header hairline."],
  ["Landing · on the Ink field", "text", "lp-stone on lp-ink", "lp-stone", "lp-ink", "Alternate light-on-dark text."],

  /* --- §2 the same labels over photography, through the scrim --- */
  ["Landing · over photo, mid scrim (lp-scrim-mid)", "text", "lp-cream over scrim on a WHITE pixel", "lp-cream", scrim("#16181dd9", PHOTO_WHITE), "Worst case: blown highlight under the 55% stop."],
  ["Landing · over photo, mid scrim (lp-scrim-mid)", "text", "lp-cream-60 over scrim on a WHITE pixel", "lp-cream-60", scrim("#16181dd9", PHOTO_WHITE), "Worst case."],
  ["Landing · over photo, mid scrim (lp-scrim-mid)", "text", "lp-cream-40 over scrim on a WHITE pixel", "lp-cream-40", scrim("#16181dd9", PHOTO_WHITE), "Worst case — the label the design leans on hardest."],
  ["Landing · over photo, mid scrim (lp-scrim-mid)", "text", "lp-cream-40 over scrim on a MID-GREY pixel", "lp-cream-40", scrim("#16181dd9", PHOTO_MID), "Typical case — still fails."],
  ["Landing · over photo, scrim base (lp-scrim-base)", "text", "lp-cream-40 over scrim on a WHITE pixel", "lp-cream-40", scrim("#16181df7", PHOTO_WHITE), "The safest band, and cream-40 still fails there."],
  ["Landing · over photo, scrim base (lp-scrim-base)", "text", "lp-cream-60 over scrim on a WHITE pixel", "lp-cream-60", scrim("#16181df7", PHOTO_WHITE), "Bottom of the scrim."],
  ["Landing · over photo, no scrim", "rule", "lp-cream on a bare WHITE pixel", "lp-cream", PHOTO_WHITE, "Proves the rule: no text may sit in the scrim's 0%-alpha band."],

  /* --- §3 sticky header, stuck state (Ink 92% + backdrop blur) --- */
  ["Sticky header · stuck (lp-ink-92)", "text", "lp-cream link over the stuck bar on a LIGHT page", "lp-cream", toHex(over("#16181deb", PHOTO_WHITE)), "Blur samples the page beneath; white is the worst case."],
  ["Sticky header · stuck (lp-ink-92)", "text", "lp-cream-60 nav link over the stuck bar on a LIGHT page", "lp-cream-60", toHex(over("#16181deb", PHOTO_WHITE)), "Inactive nav items."],
  ["Sticky header · stuck (lp-ink-92)", "text", "lp-cream-40 over the stuck bar on a LIGHT page", "lp-cream-40", toHex(over("#16181deb", PHOTO_WHITE)), "Locale code next to the globe."],
  ["Sticky header · at rest (no background)", "rule", "lp-cream-60 over an unscrimmed WHITE hero pixel", "lp-cream-60", PHOTO_WHITE, "Proves the rule: at rest the header needs its own local scrim."],

  /* --- §4 language menu --- */
  ["Language menu (lp-menu)", "text", "lp-cream row label", "lp-cream", toHex(over("#1c1f26f2", PHOTO_WHITE)), "Português, English, …"],
  ["Language menu (lp-menu)", "text", "lp-cream-60 locale code", "lp-cream-60", toHex(over("#1c1f26f2", PHOTO_WHITE)), "PT / EN / ES column."],
  ["Language menu (lp-menu)", "text", "lp-cream-40 locale code", "lp-cream-40", toHex(over("#1c1f26f2", PHOTO_WHITE)), "If the code uses the 40% tint."],

  /* --- §5 plan semantics on dark (scroll-sequence bars + HUD) --- */
  ["Plan · on lp-ink (scroll sequence)", "non-text", "plan-baseline bar fill on lp-ink", "plan-baseline", "lp-ink", "The blue lane against the dark field."],
  ["Plan · on lp-ink (scroll sequence)", "non-text", "plan-actual bar fill on lp-ink", "plan-actual", "lp-ink", "The orange lane."],
  ["Plan · on lp-ink (scroll sequence)", "non-text", "plan-closed bar fill on lp-ink", "plan-closed", "lp-ink", "The green lane."],
  ["Plan · on lp-ink (scroll sequence)", "text", "plan-baseline as HUD VALUE text on lp-ink", "plan-baseline", "lp-ink", "KF B: '€ 97,100' tinted blue."],
  ["Plan · on lp-ink (scroll sequence)", "text", "plan-actual as HUD VALUE text on lp-ink", "plan-actual", "lp-ink", "KF C: '+ € 3,200' tinted orange."],
  ["Plan · on lp-ink (scroll sequence)", "text", "plan-closed as HUD VALUE text on lp-ink", "plan-closed", "lp-ink", "KF D: '0 days slipped' tinted green."],
  ["Plan · on lp-ink (scroll sequence)", "non-text", "spec's KF-D ghost baseline — plan-baseline at 35% on lp-ink", toHex(over("#3E5C8A59", "#16181D")), "lp-ink", "Spec §3 KF D: 'blue baseline at 35%'."],
  ["Plan · on lp-ink (scroll sequence)", "decorative", "plan-baseline-line on lp-ink", "plan-baseline-line", "lp-ink", "Lane hairline on dark."],

  /* --- §6 plan semantics on light (the web app's real usage) --- */
  ["Plan · on light UI", "text", "plan-baseline-fg on plan-baseline-muted", "plan-baseline-fg", "plan-baseline-muted", "Chip text on its own tint."],
  ["Plan · on light UI", "text", "plan-actual-fg on plan-actual-muted", "plan-actual-fg", "plan-actual-muted", "Chip text on its own tint."],
  ["Plan · on light UI", "text", "plan-closed-fg on plan-closed-muted", "plan-closed-fg", "plan-closed-muted", "Chip text on its own tint."],
  ["Plan · on light UI", "text", "plan-baseline-fg on lp-cream", "plan-baseline-fg", "lp-cream", "Label on the light section."],
  ["Plan · on light UI", "text", "plan-actual-fg on lp-cream", "plan-actual-fg", "lp-cream", "Delta text on the light section."],
  ["Plan · on light UI", "text", "plan-closed-fg on lp-cream", "plan-closed-fg", "lp-cream", "Closed text on the light section."],
  ["Plan · on light UI", "text", "plan-baseline-fg on lp-stone", "plan-baseline-fg", "lp-stone", "On the stone panel."],
  ["Plan · on light UI", "text", "white on plan-baseline (filled button)", "white", "plan-baseline", "'Request access' primary."],
  ["Plan · on light UI", "text", "white on plan-actual (filled button)", "white", "plan-actual", "Builder-side filled control."],
  ["Plan · on light UI", "text", "white on plan-closed (filled button)", "white", "plan-closed", "Approve / closed control."],
  ["Plan · on light UI", "text", "plan-baseline as body text on lp-cream", "plan-baseline", "lp-cream", "Base tone used directly as type."],
  ["Plan · on light UI", "text", "plan-actual as body text on lp-cream", "plan-actual", "lp-cream", "Base tone used directly as type."],
  ["Plan · on light UI", "non-text", "plan-baseline-muted lane on lp-cream", "plan-baseline-muted", "lp-cream", "The empty lane is what gives the filled bar its scale."],
  ["Plan · on light UI", "decorative", "plan-baseline-line on lp-cream", "plan-baseline-line", "lp-cream", "Chip border, beside text that already contrasts."],
  ["Plan · on light UI", "decorative", "plan-actual-line on lp-cream", "plan-actual-line", "lp-cream", "Chip border."],
  ["Plan · on light UI", "decorative", "plan-closed-line on lp-cream", "plan-closed-line", "lp-cream", "Chip border."],

  /* --- §7 the proposed fixes, verified in the same run --- */
  ["Proposed fixes (must pass)", "fixed", "FIX A — lp-cream-60 replaces cream-40 for labels, worst backdrop", "lp-cream-60", scrim("#16181dd9", PHOTO_WHITE), "Smallest fix: the token already exists. 55% is the exact threshold; 60% is the next rung up."],
  ["Proposed fixes (must pass)", "fixed", "FIX B — plan-baseline-on-dark as HUD text on lp-ink", "plan-baseline-on-dark", "lp-ink", "New token. Also clears 3:1 for the bar fill."],
  ["Proposed fixes (must pass)", "fixed", "FIX B — plan-actual-on-dark as HUD text on lp-ink", "plan-actual-on-dark", "lp-ink", "New token."],
  ["Proposed fixes (must pass)", "fixed", "FIX B — plan-closed-on-dark as HUD text on lp-ink", "plan-closed-on-dark", "lp-ink", "New token."],
  ["Proposed fixes (must pass)", "fixed-non-text", "FIX C — KF-D ghost baseline at 80% of plan-baseline-on-dark", toHex(over("#6E85A7CC", "#16181D")), "lp-ink", "Replaces the spec's 35%, which measured 1.65:1."],
  ["Proposed fixes (must pass)", "fixed", "FIX D — white on plan-actual-fg (filled button)", "white", "plan-actual-fg", "Replaces white-on-plan-actual (4.39:1)."],
  ["Proposed fixes (must pass)", "fixed", "FIX D — plan-actual-fg as body text on lp-cream", "plan-actual-fg", "lp-cream", "Replaces plan-actual as type (4.20:1)."],
  ["Proposed fixes (must pass)", "fixed-non-text", "FIX E — plan-track-line as the empty-lane border on lp-cream", "plan-track-line", "lp-cream", "The border identifies the track, since the muted fill (1.24:1) cannot."],
  ["Proposed fixes (must pass)", "fixed-non-text", "FIX E — plan-track-line on lp-stone", "plan-track-line", "lp-stone", "Stone is the binding surface; --outline-strong fails here."],
  ["Proposed fixes (must pass)", "fixed-non-text", "FIX E — plan-track-line on paper", "plan-track-line", "paper", "The web app's surface."],
  ["Proposed fixes (must pass)", "rule", "FIX E — rejected alternative: outline-strong on lp-stone", "outline-strong", "lp-stone", "Measured to show why a new token was needed instead of reusing the existing outline."],

  /* --- §8 portal / shared semantic ramp, light mode (LINA-92) ---
     Every pair the portal actually renders, measured against the re-based
     values now in tokens.json. Dark mode is deliberately absent: the dark ramp
     has no source in the .pen and is being re-derived by the designer. --- */
  ["Portal · light, surfaces & text (LINA-92)", "text", "ink on paper", "ink", "paper", "Body text on the main surface."],
  ["Portal · light, surfaces & text (LINA-92)", "text", "ink on surface-sunken", "ink", "surface-sunken", "Body text on the app background."],
  ["Portal · light, surfaces & text (LINA-92)", "text", "ink on surface-raised", "ink", "surface-raised", "Body text on cards."],
  ["Portal · light, surfaces & text (LINA-92)", "text", "muted on paper", "muted", "paper", "Secondary text — captions, labels, .sub/.hint."],
  ["Portal · light, surfaces & text (LINA-92)", "text", "muted on surface-sunken", "muted", "surface-sunken", "Secondary text on the app background."],
  ["Portal · light, surfaces & text (LINA-92)", "text", "muted on surface-raised", "muted", "surface-raised", "Secondary text on cards."],
  ["Portal · light, surfaces & text (LINA-92)", "decorative", "outline as a card border on paper", "outline", "paper", "Container separation only — the card's own content carries the contrast. Not a 1.4.11 control border. Unchanged in kind from the retired #dcdbd7 (1.31:1)."],
  ["Portal · light, surfaces & text (LINA-92)", "decorative", "outline as a border on surface-raised", "outline", "surface-raised", "Card border against the card fill."],
  ["Portal · light, surfaces & text (LINA-92)", "non-text", "outline-strong as an input border on paper", "outline-strong", "paper", "Form controls — the border IS the affordance, so 1.4.11 genuinely applies. Pre-existing: the retired #9b9a95 scored 2.78:1."],
  ["Portal · light, surfaces & text (LINA-92)", "decorative", "line-strong as a divider on paper", "line-strong", "paper", "The visible-divider step — ornament, not a control boundary."],
  ["Portal · light, surfaces & text (LINA-92)", "decorative", "line as a hairline on paper", "line", "paper", "Table rules beside text that already contrasts."],

  ["Portal · light, ink alpha ramp (LINA-92)", "text", "ink-60 on paper", "ink-60", "paper", "Composited — the ramp is alpha, not a solid. The lowest rung that can carry body text."],
  ["Portal · light, ink alpha ramp (LINA-92)", "rule", "ink-45 as text on paper", "ink-45", "paper", "Proves the ramp's ceiling: ink-45 and below may NOT be used as body text."],
  ["Portal · light, ink alpha ramp (LINA-92)", "rule", "ink-35 as a meaningful graphic on paper", "ink-35", "paper", "Proves the ceiling: ink-35 and below may NOT carry meaning (1.4.11)."],
  ["Portal · light, ink alpha ramp (LINA-92)", "decorative", "ink-25 as a divider on paper", "ink-25", "paper", "Dividers and ornament only."],
  ["Portal · light, ink alpha ramp (LINA-92)", "decorative", "ink-15 as a hairline on paper", "ink-15", "paper", "Hairlines only — never text."],

  ["Portal · light, identity & party tags (LINA-92)", "text", "white on owner (primary button)", "white", "owner", "The .btn.primary fill."],
  ["Portal · light, identity & party tags (LINA-92)", "text", "white on builder (filled control)", "white", "builder", "Builder-side filled control."],
  ["Portal · light, identity & party tags (LINA-92)", "text", "owner as link/body text on paper", "owner", "paper", ".back, .botnav a.active, details.revs summary."],
  ["Portal · light, identity & party tags (LINA-92)", "text", "builder as body text on paper", "builder", "paper", "Builder-side type."],
  ["Portal · light, identity & party tags (LINA-92)", "text", "owner on owner-muted (party tag)", "owner", "owner-muted", ".tag.owner — the portal has no --owner-ink in the .pen, so the base tone is the candidate."],
  ["Portal · light, identity & party tags (LINA-92)", "text", "builder on builder-muted (party tag)", "builder", "builder-muted", ".tag.counterparty."],
  ["Portal · light, identity & party tags (LINA-92)", "non-text", "owner as the budget-bar fill on surface-sunken", "owner", "surface-sunken", ".budgetbar > span against its track."],

  ["Portal · light, RAG semantics (LINA-92)", "text", "success as text on paper", "success", "paper", ".pillar.green .p-state, .delta.down."],
  ["Portal · light, RAG semantics (LINA-92)", "text", "warning as text on paper", "warning", "paper", ".pillar.amber .p-state."],
  ["Portal · light, RAG semantics (LINA-92)", "text", "danger as text on paper", "danger", "paper", ".pillar.red .p-state, .delta.up."],
  ["Portal · light, RAG semantics (LINA-92)", "text", "white on success (approve button)", "white", "success", ".btn.approve."],
  ["Portal · light, RAG semantics (LINA-92)", "non-text", "success as a pillar edge on surface-raised", "success", "surface-raised", "The 4px border-left that carries the RAG state."],
  ["Portal · light, RAG semantics (LINA-92)", "non-text", "warning as a pillar edge on surface-raised", "warning", "surface-raised", "FR9 keeps a label+icon too, but the edge must still be perceivable."],
  ["Portal · light, RAG semantics (LINA-92)", "non-text", "danger as a pillar edge on surface-raised", "danger", "surface-raised", "Pillar edge."],
  ["Portal · light, RAG semantics (LINA-92)", "non-text", "danger as an icon stroke on paper", "danger", "paper", ".pillar.red .p-ic."],

  ["Portal · light, state chips (LINA-92)", "text", "state-warning-fg on state-warning-muted", "state-warning-fg", "state-warning-muted", "The .edited chip and warning banners."],
  ["Portal · light, state chips (LINA-92)", "text", "state-warning-fg on paper", "state-warning-fg", "paper", "Chip text where the fill is omitted."],
  ["Portal · light, state chips (LINA-92)", "decorative", "state-warning-line on state-warning-muted", "state-warning-line", "state-warning-muted", "Chip border beside contrasting text."],
  ["Portal · light, state chips (LINA-92)", "text", "state-danger on state-danger-muted", "state-danger", "state-danger-muted", "GAP: the .pen ships no state-danger-fg, so the base tone is the only candidate for .form-error / .integrity.bad text."],
  ["Portal · light, state chips (LINA-92)", "text", "success on plan-closed-muted (ok chip)", "success", "plan-closed-muted", "The .badge.ok pairing, now that --success and --plan-closed are one value."],

  /* --- §8b the -fg rungs the .pen omits, verified in the same run.
     Each of these MUST pass or the portal migration regresses accessibility
     against the palette it is replacing. --- */
  ["Portal · light, the -fg rungs (must pass)", "fixed", "builder-fg on builder-muted (party tag)", "builder-fg", "builder-muted", "Replaces builder-on-builder-muted (3.44:1). The retired --builder-ink did this job."],
  ["Portal · light, the -fg rungs (must pass)", "fixed", "builder-fg as body text on paper", "builder-fg", "paper", "Replaces builder as type (4.20:1)."],
  ["Portal · light, the -fg rungs (must pass)", "fixed", "white on builder-fg (filled control)", "white", "builder-fg", "Replaces white-on-builder (4.39:1)."],
  ["Portal · light, the -fg rungs (must pass)", "fixed", "success-fg on plan-closed-muted (ok chip)", "success-fg", "plan-closed-muted", "Replaces success-on-tint (4.05:1). The retired --ok-fg did this job."],
  ["Portal · light, the -fg rungs (must pass)", "fixed", "success-fg on paper", "success-fg", "paper", "Closed/approved text."],
  ["Portal · light, the -fg rungs (must pass)", "fixed", "owner-fg on owner-muted (party tag)", "owner-fg", "owner-muted", "The owner side already passes with the base tone; the -fg rung is kept for symmetry and headroom."],
  ["Portal · light, the -fg rungs (must pass)", "fixed", "owner-fg as body text on paper", "owner-fg", "paper", "Links and active nav."],

  /* --- §8c the web app's plan surfaces (LINA-87) ---
     The portal's bar/timeline/budget surfaces moved off the PARTY tokens onto
     the STATE tokens. These are the pairings .budgetbar actually renders, and
     they gate: the budget bar is how a homeowner reads how much of an agreed
     figure is spent, so if the fill stops separating from its track the number
     is still right but the picture lies. --- */
  ["Portal · plan surfaces (LINA-87, must pass)", "fixed-non-text", "plan-baseline bar fill on its plan-baseline-muted track", "plan-baseline", "plan-baseline-muted", ".budgetbar > span against the unspent remainder — this is the comparison the bar exists to make."],
  ["Portal · plan surfaces (LINA-87, must pass)", "fixed-non-text", "plan-track-line as the budget-bar track border on surface-raised", "plan-track-line", "surface-raised", "The bar sits in a card. --outline is 1.38:1 here, so the track's extent — and therefore the bar's scale — needed FIX E's border."],
  ["Portal · plan surfaces (LINA-87, must pass)", "fixed-non-text", "warning fill on the plan-baseline-muted track (over-baseline)", "warning", "plan-baseline-muted", ".budgetbar.over > span. FR9 still pairs this with a label + icon; the colour is not the only signal."],
  ["Portal · plan surfaces (LINA-87, must pass)", "fixed", "plan-baseline-fg as type on paper", "plan-baseline-fg", "paper", "Baseline figures in the portal."],
  ["Portal · plan surfaces (LINA-87, must pass)", "fixed", "plan-actual-fg as type on paper", "plan-actual-fg", "paper", "Actual/variance figures in the portal."],
  ["Portal · plan surfaces (LINA-87, must pass)", "fixed", "plan-closed-fg as type on paper", "plan-closed-fg", "paper", "Settled/closed figures."],

  /* --- §8d the portal's DARK scheme (LINA-106 ramp, LINA-92 migration) ---
     The dark ramp has no source in the .pen — it was derived from the re-based
     primitives — so every rung here is measured rather than trusted. The whole
     set is `fixed`/`fixed-non-text`, i.e. gating: dark mode is now generated
     from the same token source as light, so a dark regression must break the
     build rather than wait for someone with a dark laptop to notice.

     The two-tier contract inverts across schemes and that is the thing most
     likely to be got wrong later: in LIGHT the `-fg` rung is DARKER than its
     base, in DARK it is BRIGHTER. Both directions exist for the same reason —
     the base tone is tuned to be a fill under white type, so it can never also
     be the readable type colour on the page surface. --- */
  ["Portal · dark, surfaces & text (LINA-106)", "fixed", "ink on paper", "d:ink", "d:paper", "Body text on the main surface."],
  ["Portal · dark, surfaces & text (LINA-106)", "fixed", "ink on surface-sunken", "d:ink", "d:surface-sunken", "Body text on the app background."],
  ["Portal · dark, surfaces & text (LINA-106)", "fixed", "ink on surface-raised", "d:ink", "d:surface-raised", "Body text on cards."],
  ["Portal · dark, surfaces & text (LINA-106)", "fixed", "muted on paper", "d:muted", "d:paper", "Secondary text — captions, .sub/.hint."],
  ["Portal · dark, surfaces & text (LINA-106)", "fixed", "muted on surface-raised", "d:muted", "d:surface-raised", "Secondary text on cards."],
  ["Portal · dark, surfaces & text (LINA-106)", "fixed-non-text", "outline-strong as an input border on paper", "d:outline-strong", "d:paper", "Form controls, where the border IS the affordance. Dark CLEARS the 1.4.11 floor here at 3.17:1 — light still does not. See the open item."],
  ["Portal · dark, surfaces & text (LINA-106)", "fixed-non-text", "outline-strong as an input border on surface-raised", "d:outline-strong", "d:surface-raised", "The same control inside a card — the tighter of the two backdrops."],
  ["Portal · dark, surfaces & text (LINA-106)", "decorative", "outline as a card border on paper", "d:outline", "d:paper", "Container separation only, matching light mode's treatment."],
  ["Portal · dark, surfaces & text (LINA-106)", "decorative", "line as a hairline on paper", "d:line", "d:paper", "Table rules. Derived as 55% outline over paper."],
  ["Portal · dark, surfaces & text (LINA-106)", "decorative", "line-strong as a divider on paper", "d:line-strong", "d:paper", "Visible divider. Derived as 55% outline-strong over paper."],

  ["Portal · dark, ink alpha ramp (LINA-92)", "fixed", "ink-60 on paper", "d:ink-60", "d:paper", "Composited. The dark ramp is CREAM at the same alpha stops — using the light ink ramp here would paint dark-on-dark."],
  ["Portal · dark, ink alpha ramp (LINA-92)", "rule", "ink-45 as text on paper", "d:ink-45", "d:paper", "Measured to locate the ramp's ceiling in dark, as §8 does for light."],
  ["Portal · dark, ink alpha ramp (LINA-92)", "decorative", "ink-25 as a divider on paper", "d:ink-25", "d:paper", "Dividers and ornament only."],
  ["Portal · dark, ink alpha ramp (LINA-92)", "decorative", "ink-15 as a hairline on paper", "d:ink-15", "d:paper", "Hairlines only — never text."],

  ["Portal · dark, identity & party tags (LINA-106)", "fixed", "white on owner (primary button)", "white", "d:owner", "The .btn.primary fill. The dark base is DARKER than the light base precisely so white type still clears on it."],
  ["Portal · dark, identity & party tags (LINA-106)", "fixed", "white on builder (filled control)", "white", "d:builder", "Builder-side filled control."],
  ["Portal · dark, identity & party tags (LINA-106)", "fixed", "owner-fg as link/body text on paper", "d:owner-fg", "d:paper", ".back, .botnav a.active. The -fg rung, not the base."],
  ["Portal · dark, identity & party tags (LINA-106)", "fixed", "builder-fg as body text on paper", "d:builder-fg", "d:paper", "Builder-side type."],
  ["Portal · dark, identity & party tags (LINA-106)", "fixed", "owner-fg on owner-muted (party tag)", "d:owner-fg", "d:owner-muted", ".tag.owner."],
  ["Portal · dark, identity & party tags (LINA-106)", "fixed", "builder-fg on builder-muted (party tag)", "d:builder-fg", "d:builder-muted", ".tag.counterparty."],
  ["Portal · dark, identity & party tags (LINA-106)", "rule", "owner as body text on paper", "d:owner", "d:paper", "Proves the two-tier rule in dark: the BASE tone may not be used as type — it is a fill. Use owner-fg."],
  ["Portal · dark, identity & party tags (LINA-106)", "fixed-non-text", "owner as the budget-bar fill on surface-sunken", "d:owner", "d:surface-sunken", ".budgetbar > span against its track."],

  ["Portal · dark, RAG semantics (LINA-106)", "fixed", "white on success (approve button)", "white", "d:success", ".btn.approve."],
  ["Portal · dark, RAG semantics (LINA-106)", "fixed", "success-fg as text on paper", "d:success-fg", "d:paper", ".pillar.green .p-state, .delta.down."],
  ["Portal · dark, RAG semantics (LINA-106)", "fixed-non-text", "success as a pillar edge on surface-raised", "d:success", "d:surface-raised", "The 4px border-left that carries the RAG state."],
  ["Portal · dark, RAG semantics (LINA-106)", "fixed-non-text", "warning as a pillar edge on surface-raised", "d:warning", "d:surface-raised", "FR9 keeps label+icon too, but the edge must still be perceivable."],
  ["Portal · dark, RAG semantics (LINA-106)", "fixed-non-text", "danger as a pillar edge on surface-raised", "d:danger", "d:surface-raised", "Pillar edge."],

  ["Portal · dark, state chips (LINA-106)", "fixed", "state-warning-fg on state-warning-muted", "d:state-warning-fg", "d:state-warning-muted", "The .edited chip and warning banners."],
  ["Portal · dark, state chips (LINA-106)", "fixed", "state-danger-fg on state-danger-muted", "d:state-danger-fg", "d:state-danger-muted", ".form-error / .integrity.bad. The rung LINA-106 finding 2 added — light had no -fg here either until this issue."],
  ["Portal · dark, state chips (LINA-106)", "fixed", "success-fg on plan-closed-muted (ok chip)", "d:success-fg", "d:plan-closed-muted", "The .badge.ok pairing — --ok-bg aliases the plan-closed tint, since the .pen specifies no state-success ramp."],
  ["Portal · dark, state chips (LINA-106)", "decorative", "state-warning-line on state-warning-muted", "d:state-warning-line", "d:state-warning-muted", "Chip border beside contrasting text."],
  ["Portal · dark, state chips (LINA-106)", "decorative", "state-danger-line on state-danger-muted", "d:state-danger-line", "d:state-danger-muted", "Chip border."],

  /* --- §8e the portal's plan surfaces in dark (LINA-92) ---
     This is where the migration found a live accessibility bug. globals.css
     bound the dark `plan-*-fg` to the ratified `-on-dark` base tones, which are
     correct as TYPE on the landing's ink field but only reach ~4.0:1 on their
     own chip tint — so every baseline/actual/closed chip failed 1.4.3 in dark
     mode. The fix mirrors light, where plan-baseline-fg IS owner-fg. --- */
  ["Portal · dark, plan surfaces (LINA-92, must pass)", "fixed", "plan-baseline-fg on plan-baseline-muted", "d:plan-baseline-fg", "d:plan-baseline-muted", "Baseline chip text. Was 3.99:1 when bound to the base tone."],
  ["Portal · dark, plan surfaces (LINA-92, must pass)", "fixed", "plan-actual-fg on plan-actual-muted", "d:plan-actual-fg", "d:plan-actual-muted", "Actual chip text. Was 4.03:1."],
  ["Portal · dark, plan surfaces (LINA-92, must pass)", "fixed", "plan-closed-fg on plan-closed-muted", "d:plan-closed-fg", "d:plan-closed-muted", "Closed chip text. Was 3.99:1."],
  ["Portal · dark, plan surfaces (LINA-92, must pass)", "fixed", "plan-baseline-fg as type on paper", "d:plan-baseline-fg", "d:paper", "Baseline figures in the portal."],
  ["Portal · dark, plan surfaces (LINA-92, must pass)", "fixed", "plan-actual-fg as type on paper", "d:plan-actual-fg", "d:paper", "Actual/variance figures."],
  ["Portal · dark, plan surfaces (LINA-92, must pass)", "fixed", "plan-closed-fg as type on paper", "d:plan-closed-fg", "d:paper", "Settled/closed figures."],
  ["Portal · dark, plan surfaces (LINA-92, must pass)", "fixed-non-text", "plan-baseline bar fill on its plan-baseline-muted track", "d:plan-baseline", "d:plan-baseline-muted", "The comparison the budget bar exists to make — spent against agreed."],
  ["Portal · dark, plan surfaces (LINA-92, must pass)", "fixed-non-text", "plan-track-line as the budget-bar track border on surface-raised", "d:plan-track-line", "d:surface-raised", "The tightest of the three dark surfaces, and the one the bar actually sits on. The obvious pick (#6b6a64, what globals.css used) measured 2.90:1 and missed the floor."],
  ["Portal · dark, plan surfaces (LINA-92, must pass)", "fixed-non-text", "plan-track-line as the track border on paper", "d:plan-track-line", "d:paper", "Same border, on the plain surface."],
  ["Portal · dark, plan surfaces (LINA-92, must pass)", "fixed-non-text", "plan-track-line as the track border on surface-sunken", "d:plan-track-line", "d:surface-sunken", "Same border, on the app background."],
  ["Portal · dark, plan surfaces (LINA-92, must pass)", "fixed-non-text", "warning fill on the plan-baseline-muted track (over-baseline)", "d:warning", "d:plan-baseline-muted", ".budgetbar.over > span. FR9 still pairs this with a label + icon."],

  /* --- §9 incumbent regressions carried from LINA-46 ---
     Retired values, kept as a record of what the re-basing fixed. --- */
  ["Incumbents (LINA-46 carry-over, retired)", "text", "white on the retired owner #2a78d6 (primary button)", "white", "owner-retired", "Fixed by LINA-86/92 — see the portal section above."],
  ["Incumbents (LINA-46 carry-over, retired)", "text", "white on the retired builder #eb6834", "white", "builder-retired", "Fixed by LINA-86/92."],
  ["Incumbents (LINA-46 carry-over, retired)", "text", "the retired warning #b7791f as text on the retired paper", "warning-retired", "paper-retired", "Why --warning had to move, not just the primitives."],
  ["Incumbents (LINA-46 carry-over, retired)", "text", "the retired danger #c0392b as text on the retired paper", "danger-retired", "paper-retired", "Why --danger had to move."],
  ["Incumbents (LINA-46 carry-over, retired)", "text", "fade #9a9a9a on paper ('built-in.' slogan)", "fade", "paper", "Known fail — still open, and NOT addressed by LINA-92."],
  ["Incumbents (LINA-46 carry-over, retired)", "text", "the retired muted #5b5b58 on the retired paper", "muted-retired", "paper-retired", "The old baseline for secondary text."],
  ["Incumbents (LINA-46 carry-over, retired)", "text", "the retired ink #0b0b0b on the retired paper", "ink-retired", "paper-retired", "Old body text."],
];

/* ---------- run ---------- */

const rows = checks.map(([group, kind, label, fg, bg, note]) => {
  const fgHex = v(fg);
  const bgHex = v(bg);
  const bgSolid = hex(bgHex)[3] < 1 ? over(bgHex, "#ffffff") : hex(bgHex);
  const fgSolid = hex(fgHex)[3] < 1 ? over(fgHex, toHex(bgSolid)) : hex(fgHex);
  const r = ratio(fgSolid, bgSolid);
  const min = MIN[kind];
  return {
    group, kind, label, note, min, r,
    blocking: min > 0 && r < min,
    fgHex, bgHex,
    effective: toHex(fgSolid),
    onto: toHex(bgSolid),
  };
});

const fails = rows.filter((x) => x.blocking && !GATING.has(x.kind));
const brokenFixes = rows.filter((x) => x.blocking && GATING.has(x.kind));
const fmt = (n) => n.toFixed(2);
const verdict = (x) => {
  if (x.kind === "rule") return "n/a — constraint";
  if (x.kind === "decorative") return "n/a — decorative";
  return x.blocking ? "**FAIL**" : "PASS";
};

const groups = [...new Set(rows.map((x) => x.group))];
const body = groups
  .map((g) => {
    const rs = rows.filter((x) => x.group === g);
    const head =
      "| Check | Foreground → effective | Onto | Ratio | Kind | Min | Result | Where |\n" +
      "|---|---|---|---|---|---|---|---|";
    const lines = rs.map(
      (x) =>
        `| ${x.label} | \`${x.fgHex}\`${x.effective.toLowerCase() !== x.fgHex.toLowerCase() ? ` → \`${x.effective}\`` : ""} | \`${x.onto}\` | ${fmt(x.r)}:1 | ${x.kind} | ${x.min ? x.min.toFixed(1) : "—"} | ${verdict(x)} | ${x.note} |`,
    );
    return `### ${g}\n\n${head}\n${lines.join("\n")}`;
  })
  .join("\n\n");

const md = `<!-- GENERATED by design-system/contrast-audit.mjs — run \`npm run contrast\`. Do not edit by hand. -->

# Contrast audit — LinkNMS tokens

Scope: the LINA-80 additions (plan semantics, landing palette) plus the LINA-46
incumbents, so one file answers "is this safe to build".

WCAG 2.1 floors — body text **4.5:1** (1.4.3), large text (≥24px, or ≥18.7px at
weight 700) **3.0:1**, meaningful graphics **3.0:1** (1.4.11). Ornament that sits
beside something already contrasting has no floor and is reported as
\`decorative\` rather than inflated into a failure.

Translucent foregrounds are composited onto their backdrop before measurement.
\`--lp-cream-40\` is a 40%-alpha cream, so its real contrast depends entirely on
what is behind it — measuring the token in isolation tells you nothing. Where the
backdrop is a photograph the audit probes the two cases that decide the outcome:
a blown-highlight pixel (\`#ffffff\`) and a mid-grey (\`#808080\`).

**${rows.length} checks · ${fails.length} blocking failures · ${brokenFixes.length} proposed fixes that do not hold.**

${body}

## Blocking failures, in one list

${fails.length === 0 ? "None." : fails.map((x) => `- **${fmt(x.r)}:1** (${x.kind}, needs ${x.min.toFixed(1)}) — ${x.label} — _${x.note}_`).join("\n")}

Every one of these has a proposed fix in
[\`landing-tokens-decisions.md\`](./landing-tokens-decisions.md) §5, and the fixes
are re-measured in the "Proposed fixes" table above — so a fix cannot silently
stop working without this file turning red.
`;

await fs.writeFile(OUT, md);
console.log(`${rows.length} checks · ${fails.length} blocking · ${brokenFixes.length} broken fixes → ${path.relative(ROOT, OUT)}`);
for (const f of fails) console.log(`  FAIL ${fmt(f.r)}:1 (${f.kind}, min ${f.min}) — ${f.label}`);
for (const f of brokenFixes) console.log(`  BROKEN FIX ${fmt(f.r)}:1 — ${f.label}`);
if (brokenFixes.length) process.exitCode = 1;
