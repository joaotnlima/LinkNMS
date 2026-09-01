export default {
  title: "Components/Landing",
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Marketing-site components from the LINA-108 landing redesign. Ground truth: the `landing-page`, `landing-page (mobile 390)`, `Header — sticky states` and `key-frames` frames in cowork/pen/linkNMS.pen.\n\n" +
          "**Tokens:** every colour and font here reads the `--plan-*` / `--lp-*` family in design-system/tokens.json (added LINA-108) — the landing keeps its own palette separate from the product UI. **Marketing scope only — the product UI does not use these.**\n\n" +
          "**Where a frame value fails WCAG, this specimen carries the fix and says so inline.** Three moves recur: micro-labels never sit at `--lp-cream-40` (fails 4.5:1 on every landing backdrop) — they use `--lp-cream-60`; the KF-D residual baseline runs at 80% opacity, not the frame's 35% (1.34:1, invisible); the plan colours on the ink field use lighter tints, never the base tones (baseline is 2.62:1 on ink).",
      },
    },
  },
};

const LOCALES = [
  ["Português", "PT", true],
  ["English", "EN", false],
  ["Español", "ES", false],
  ["Français", "FR", false],
  ["Deutsch", "DE", false],
  ["Italiano", "IT", false],
  ["Polski", "PL", false],
  ["Українська", "UK", false],
  ["Română", "RO", false],
];

const globe = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>`;
const tick = `<svg class="lp-lang__tick" viewBox="0 0 13 13" aria-hidden="true"><path d="M2 6.5 5 9.5 11 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

const langMenu = (open) => `
  <div class="lp-lang">
    <button class="lp-lang__trigger" aria-expanded="${open}" aria-haspopup="true">${globe}<span>PT</span></button>
    ${
      open
        ? `<ul class="lp-lang__panel">
        ${LOCALES.map(
          ([name, code, on]) =>
            `<li><a href="#" ${on ? 'aria-current="true"' : ""}>${tick}<span>${name}</span><span class="code">${code}</span></a></li>`,
        ).join("")}
      </ul>`
        : ""
    }
  </div>`;

const header = (state) => `
  <header class="lp lp-header ${state}" data-stuck="${state === "stuck"}">
    <div class="lp-header__slot">
      ${
        state === "rest"
          ? `<span class="lp-header__status"><span class="lp-header__dot"></span>Built for turnkey. Made for trust.</span>`
          : `<span class="lp-header__lockup lp-display" style="font-size:19px">linknms</span>`
      }
    </div>
    <nav class="lp-header__nav">
      <a href="#" aria-current="true">The problem</a>
      <a href="#">How it works</a>
      <a href="#">For builders</a>
      <a href="#">Pricing</a>
      ${langMenu(false)}
      <button class="lp-cta">Request access</button>
    </nav>
  </header>`;

export const StickyHeader = {
  name: "Sticky header — rest / stuck",
  render: () => `
    <div class="lp-demo">
      <div class="lp-stage-demo lp-header-guard" style="padding-bottom:16px">${header("rest")}</div>
      <p class="cap">At rest · over the hero · no background, no border · <code>82px</code></p>
      <div class="lp-stage-demo" style="padding-bottom:16px">${header("stuck")}</div>
      <p class="cap">Stuck · Ink 92% + <code>18px</code> backdrop blur + hairline · <code>64px</code></p>
      <p class="lp-note">
        One element, <code>position: fixed</code> from the first paint — it never re-mounts, it only
        restyles. Stuck styles switch on when <code>scrollY &gt; 120px</code>, not when the hero ends
        (waiting leaves it floating with no background over section 01). <b>Content colour never
        flips:</b> links, language and CTA stay cream in both states, so only
        <code>background-color</code>, <code>height</code> and <code>padding</code> transition
        (180ms ease-out).
      </p>
      <p class="lp-note">
        <b>Why the lockup appears when stuck.</b> At rest the brand is the 196px LINKNMS wordmark in
        the hero — the header does not need to repeat it. Once stuck, that wordmark has scrolled
        away and the page has no brand on screen for the remaining ~5,000px. The lockup is not
        decoration; it is the only <i>linknms</i> in the viewport.
      </p>
      <p class="lp-note">
        <b>Open conflict to resolve before build:</b> a fixed header and a GSAP-pinned section fight.
        Either give ScrollTrigger <code>pinnedContainer</code> padding equal to the header height, or
        hide the header for the pin's duration. Retrofit is painful.
      </p>
    </div>`,
};

export const LanguageMenu = {
  name: "Language menu — 9 locales",
  render: () => `
    <div class="lp-demo">
      <div class="lp-stage-demo" style="padding:24px 28px 220px;display:flex;justify-content:flex-end">
        ${langMenu(true)}
      </div>
      <p class="lp-note">
        Nine locales, so the control is a <b>menu, not a toggle</b> — a toggle cannot express nine
        options. Trigger is globe + the active code; the panel is right-aligned to the trigger,
        <code>236px</code>, Ink at 95% + 18px blur. The <code>uk</code> entry is Українська, not the
        Latin-script PT/EN/ES/FR/DE/IT/PL/RO set.
      </p>
      <p class="lp-note">
        First visit picks from <code>Accept-Language</code>, falls back to PT. <b>Never geo-IP</b> —
        a Ukrainian bricklayer on a Portuguese site should get Ukrainian. Persist in a cookie, not
        just localStorage, so the server renders the right language next request (no flash of wrong
        copy). Each locale needs a real URL with <code>hreflang</code>.
      </p>
      <p class="lp-note">
        <b>Locale codes are <code>--lp-cream-60</code>.</b> At cream-40 they measure 3.49:1 here and
        fail. Same for <code>Українська</code>: Archivo ships no Cyrillic subset, so <code>uk</code>
        falls back to the system stack until we pair a Cyrillic face (or set the fallback
        deliberately).
      </p>
    </div>`,
};

const planRow = (name, planned, actual) => `
  <div class="lp-plan-row">
    <span class="name">${name}</span>
    <div class="lp-track">
      <div class="lp-lane planned"><span class="fill ${planned.s}" style="left:${planned.o}px;width:${planned.w}px"></span></div>
      <div class="lp-lane actual"><span class="fill ${actual.s}" style="left:${actual.o}px;width:${actual.w}px"></span></div>
    </div>
  </div>`;

const ROWS_KF_C = [
  ["Foundations", { o: 0, w: 60, s: "baseline" }, { o: 0, w: 60, s: "closed" }],
  ["Structure", { o: 60, w: 80, s: "baseline" }, { o: 60, w: 80, s: "closed" }],
  ["Envelope", { o: 140, w: 80, s: "baseline" }, { o: 140, w: 80, s: "closed" }],
  ["Finishes", { o: 220, w: 100, s: "baseline" }, { o: 240, w: 80, s: "actual" }],
];
const ROWS_KF_D = [
  ["Foundations", { o: 0, w: 60, s: "baseline ghost" }, { o: 0, w: 60, s: "closed" }],
  ["Structure", { o: 60, w: 80, s: "baseline ghost" }, { o: 60, w: 80, s: "closed" }],
  ["Envelope", { o: 140, w: 80, s: "baseline ghost" }, { o: 140, w: 80, s: "closed" }],
  ["Finishes", { o: 220, w: 100, s: "baseline ghost" }, { o: 220, w: 100, s: "closed" }],
];

export const PlanBarTrack = {
  name: "Plan-bar track — planned / actual lanes",
  render: () => `
    <div class="lp-demo">
      <div class="lp lp-field">
        <p class="lp-micro" style="margin:0 0 14px">p 0.40 → 0.70 · the slip appears</p>
        <div class="lp-plan">${ROWS_KF_C.map(([n, p, a]) => planRow(n, p, a)).join("")}</div>
      </div>
      <p class="cap">Ink field · lighter tints, baseline/actual/closed</p>
      <div class="lp lp-field">
        <p class="lp-micro" style="margin:0 0 14px">p 1.00 · everything closes</p>
        <div class="lp-plan">${ROWS_KF_D.map(([n, p, a]) => planRow(n, p, a)).join("")}</div>
      </div>
      <p class="cap">KF D · residual baseline at 80%, not the frame's 35%</p>
      <div class="lp lp-light">
        <div class="lp-plan">${ROWS_KF_C.map(([n, p, a]) => planRow(n, p, a)).join("")}</div>
      </div>
      <p class="cap">Light surface · base tones, empty lane bordered</p>
      <p class="lp-note">
        Planned lane above, actual lane below. 7px lanes on desktop, 6px below <code>768px</code>.
        Square corners — these read as drawing, not as UI. Never a raster image: the bars are DOM/SVG
        so they stay crisp at any density and only <code>opacity</code> animates in the sequence.
      </p>
      <p class="lp-note">
        The three colours are the section's whole argument: <b>blue</b> is what you agreed,
        <b>orange</b> what changed, <b>green</b> what closed. Colour is never the only signal — the
        planned lane always sits above the actual lane, and rows carry the work-package name.
      </p>
    </div>`,
};

const hud = (state, time, cost, scope) => `
  <div class="lp lp-field">
    <div class="lp-hud">
      <div class="cell ${state}"><span class="k">Time</span><span class="v ${state}">${time}</span></div>
      <div class="cell ${state}"><span class="k">Cost</span><span class="v ${state}">${cost}</span></div>
      <div class="cell ${state}"><span class="k">Scope</span><span class="v ${state}">${scope}</span></div>
    </div>
  </div>`;

export const HUD = {
  name: "HUD triple — TIME / COST / SCOPE",
  render: () => `
    <div class="lp-demo">
      ${hud("baseline", "8 months", "€ 97,100", "100%")}
      <p class="cap">KF B · the plan</p>
      ${hud("actual", "+ 9 days", "+ € 3,200", "98%")}
      <p class="cap">KF C · the slip</p>
      ${hud("closed", "0 days slipped", "€ 97,100", "100%")}
      <p class="cap">KF D · the outcome</p>
      <p class="lp-note">
        Values set in <code>--lp-display</code> with tabular figures so the three numbers do not
        jitter as they animate. Labels are <code>--lp-cream-60</code> (cream-40 measures 3.71:1 on
        ink). On the ink field the value tints are the lighter variants — base <code>--plan-*</code>
        tones fail 4.5:1 there.
      </p>
      <p class="lp-note">
        Colour is never the only signal: each cell carries a state-coloured top rule, so the
        blue→orange→green progression survives greyscale and colour-blindness.
      </p>
    </div>`,
};

const KF = {
  A: () => `
    <article class="kf-frame">
      <p class="lp-micro" style="display:flex;justify-content:space-between;margin:0">
        <span>KF A · p = 0.15</span><span>The drawing</span>
      </p>
      <div class="kf-still">
        <p class="kf-placeholder">stage-1-design.png</p>
        <div class="kf-hud"></div>
      </div>
      <p class="kf-meta">
        <span><b>house.src</b> stage-1-design.png</span>
        <span><b>bars</b> opacity 0</span>
        <span><b>hud</b> opacity 0</span>
      </p>
    </article>`,
  B: () => `
    <article class="kf-frame">
      <p class="lp-micro" style="display:flex;justify-content:space-between;margin:0">
        <span>KF B · p = 0.40</span><span>The structure</span>
      </p>
      <div class="kf-still">
        <p class="kf-placeholder">stage-2-structure.png</p>
        <div class="kf-hud">
          <div class="hud-cell"><span class="k">Time</span><span class="v baseline">8 months</span></div>
          <div class="hud-cell"><span class="k">Cost</span><span class="v baseline">€ 97,100</span></div>
          <div class="hud-cell"><span class="k">Scope</span><span class="v baseline">100%</span></div>
        </div>
      </div>
      <p class="kf-meta">
        <span><b>house.src</b> stage-2-structure.png</span>
        <span><b>bars</b> Foundations + Structure green · rest blue</span>
        <span><b>crossfade</b> from stage-1 · p 0.15 → 0.40</span>
      </p>
    </article>`,
  C: () => `
    <article class="kf-frame">
      <p class="lp-micro" style="display:flex;justify-content:space-between;margin:0">
        <span>KF C · p = 0.70</span><span>The slip</span>
      </p>
      <div class="kf-still">
        <p class="kf-placeholder">stage-3-finishing.png</p>
        <div class="kf-hud">
          <div class="hud-cell"><span class="k">Time</span><span class="v actual">+ 9 days</span></div>
          <div class="hud-cell"><span class="k">Cost</span><span class="v actual">+ € 3,200</span></div>
          <div class="hud-cell"><span class="k">Scope</span><span class="v actual">98%</span></div>
        </div>
      </div>
      <p class="kf-meta">
        <span><b>house.src</b> stage-3-finishing.png</span>
        <span><b>bars</b> 3 green · Finishes blue + orange</span>
        <span><b>hud</b> orange · slip in progress</span>
      </p>
    </article>`,
  D: () => `
    <article class="kf-frame">
      <p class="lp-micro" style="display:flex;justify-content:space-between;margin:0">
        <span>KF D · p = 1.00</span><span>The house</span>
      </p>
      <div class="kf-still">
        <p class="kf-placeholder">stage-4-house-built.png</p>
        <div class="kf-hud">
          <div class="hud-cell"><span class="k">Time</span><span class="v closed">0 days slipped</span></div>
          <div class="hud-cell"><span class="k">Cost</span><span class="v closed">€ 97,100</span></div>
          <div class="hud-cell"><span class="k">Scope</span><span class="v closed">100%</span></div>
        </div>
      </div>
      <p class="kf-meta">
        <span><b>house.src</b> stage-4-house-built.png</span>
        <span><b>bars</b> 4 green · blue baseline at 35%</span>
        <span><b>hud</b> green · outcome</span>
      </p>
    </article>`,
};

export const KeyframeSequence = {
  name: "Scroll sequence — the drawing becomes the house",
  render: () => `
    <div class="lp-demo">
      <div class="lp kf-grid">
        ${KF.A()}
        ${KF.B()}
        ${KF.C()}
        ${KF.D()}
      </div>
      <p class="lp-note">
        A pinned section, ~300vh of scroll mapped to <code>p ∈ [0,1]</code>. Four stills of the same
        house cross-fade under a plan overlay. <b>The house never advances with scroll — it advances
        when a bar closes.</b> Foundations + Structure close → stage-2; Envelope closes → stage-3;
        Finishes closes → stage-4. If the image swap is wired straight to p without going through the
        state of the bars, the section loses its argument and becomes a pretty slideshow.
      </p>
      <p class="lp-note">
        <b>Technique:</b> four <code>&lt;img&gt;</code> stacked absolutely, same size — only
        <code>opacity</code> animates (Lenis + GSAP ScrollTrigger, <code>pin</code>,
        <code>scrub: 1</code>, <code>end: "+=300%"</code>). Bars and HUD are SVG/DOM on top, never
        baked into the images: they use the real product tokens and stay crisp at any density.
      </p>
      <p class="lp-note">
        <b>Fallbacks:</b> the final state (p=1, stage-4) is the default HTML; JS winds it back to p=0
        and only then starts. With no JS, reduced-motion, 3G or a phone, everyone still sees the
        finished house and the three numbers. Disable the animation on
        <code>prefers-reduced-motion</code>, <code>&lt;768px</code>, <code>saveData</code> and
        <code>effectiveType 2g/3g</code>.
      </p>
      <p class="lp-note">
        <b>Asset warning:</b> stage-1 is shot from a different camera angle than the other three, so
        the 1→2 cross-fade jumps. Either re-render stage-1 from the stage-4 camera, or make 1→2 a cut
        masked by the wireframe lines redrawing — never a fade.
      </p>
    </div>`,
};

export const Chip = {
  name: "Chip — agreed / changed / closed",
  render: () => `
    <div class="lp-demo">
      <div class="lp lp-light">
        <div class="row">
          <span class="lp-chip baseline">Agreed</span>
          <span class="lp-chip actual">Changed</span>
          <span class="lp-chip closed">Closed</span>
        </div>
      </div>
      <p class="lp-note">
        <b><code>--plan-*</code> is the fill, <code>--plan-*-fg</code> is the type.</b>
        <code>--plan-actual</code> as text on cream is 4.20:1; <code>--plan-actual-fg</code> is
        6.81:1. The <code>-line</code> borders are decorative (1.5–1.6:1) — each chip also carries a
        square marker and a word so colour is never the only signal.
      </p>
    </div>`,
};

export const GradientScrim = {
  name: "Gradient scrim",
  render: () => `
    <div class="lp-demo">
      <div class="lp lp-scrim-demo">
        <div class="photo"></div>
        <div class="lp-scrim"></div>
        <div class="caption">
          <p class="lp-micro" style="color:var(--lp-cream-60);margin:0 0 6px">Available on</p>
          <p class="lp-display" style="margin:0;font-size:26px;color:var(--lp-cream)">iOS app · Mobile web · Desktop web</p>
        </div>
      </div>
      <p class="lp-note">
        Ink 35% → 85% → 97% from the top of the card, full-height above the caption. The backdrop
        here runs to pure white deliberately — that highlight is the worst case the scrim has to
        carry, and it is what gets measured.
      </p>
      <p class="lp-note">
        <b>No text may sit in the 0%-alpha band.</b> Cream on a bare white pixel is 1.04:1 — the
        scrim is not decoration, it is the only reason any of this text is legible. The label above
        is cream-60, not cream-40.
      </p>
    </div>`,
};