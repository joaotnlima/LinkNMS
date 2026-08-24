# LinkNMS — Design system tooling

Keep the identity **living** without reprocessing anything by hand. You edit
*source* (tokens + SVG masters), a build step regenerates everything, and CI
publishes the brand-book. No manual export loop.

## The idea

```
SOURCE (you edit)                 BUILD (generated)              PUBLISH
─────────────────                 ─────────────────              ───────
tokens/tokens.json   ──tokens──►  brand-book/tokens.css          GitHub Pages
cowork/design/logos/*.svg ─icons─► brand-kit/icon/*              (Actions on push)
brand-book/index.html                  ↑ consumed by the book and the app
```

- **Tokens** — colour, type, spacing, radius live once in
  `tokens/tokens.json` (W3C Design Tokens format). `npm run tokens`
  regenerates `cowork/design/brand-book/tokens.css` (CSS custom properties)
  and `build/tokens.json`. The brand-book and, later, the web app consume
  the same variables — change a hex in one place, everything follows.
- **Logo assets** — the mark lives in `cowork/design/logos/icon.svg`.
  `npm run icons` regenerates the whole `brand-kit/icon/` set (PNG 16–1024,
  webp, favicon) from it. Icons carry no text.
- **Brand-book** — `cowork/design/brand-book/index.html` documents logo,
  palette, type, and live interface components. It links the generated
  `tokens.css`, so it always reflects the current tokens.

## Commands

```bash
npm install        # once (installs sharp, svgo, png-to-ico)
npm run tokens     # tokens.json → tokens.css
npm run icons      # logos/icon.svg → brand-kit/icon/*
npm run build      # both
npm run book       # serve the brand-book locally (npx serve)
```

`npm run tokens` has **no dependencies** and works before `npm install`.
`npm run icons` needs the dev dependencies.

## Updating

| To change… | Edit… | Then |
|---|---|---|
| A colour / type / spacing token | `tokens/tokens.json` | `npm run tokens` |
| The logo mark | `cowork/design/logos/icon.svg` | `npm run icons` |
| A lockup (name/slogan) | `cowork/design/logos/logo-*.svg` | commit the SVG (masters are the source) |
| Brand-book content / components | `cowork/design/brand-book/index.html` | — |

## CI / publishing

`.github/workflows/brand-book.yml` runs on push to `main`: it builds tokens
and icons (validating the pipeline) and, if GitHub Pages is enabled for the
repo, deploys the brand-book. **Note:** Pages on a *private* repo needs a
paid GitHub plan; on free, either make the repo public or download the built
artifact from the workflow run.

## Growing this later

This intentionally stays tiny. When the web app and a real component library
exist, layer on the standard tools without changing the token source:

- **Style Dictionary** or **Terrazzo/Cobalt** — swap `scripts/build-tokens.mjs`
  to also emit a Tailwind preset, iOS/Android, etc. from the same `tokens.json`.
- **Storybook** — an interactive component explorer once components are code.
- **Astro Starlight** / **VitePress** — a markdown-driven docs site if you
  outgrow the single-page brand-book.
- **zeroheight** / **Supernova** — hosted, low-code, Figma-connected guidelines
  if a non-developer should maintain the book.
