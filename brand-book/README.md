# LinkNMS — Brand Book (Storybook)

The browsable, **online-deployable** brand book for LinkNMS: logo, colour,
typography, voice, and interface components — built with
[Storybook](https://storybook.js.org/) (HTML + Vite, no framework required).

Lives outside `cowork/` on purpose: `cowork/` is product definition; this is a
publishable site.

## Run locally

```bash
cd brand-book
npm install
npm run storybook          # dev server at http://localhost:6006
```

## Build & publish

```bash
npm run build-storybook    # static site → brand-book/storybook-static/
```

Deploys automatically via `.github/workflows/storybook.yml` (GitHub Pages) on
push to `main`. **Note:** Pages on a *private* repo needs a paid GitHub plan; on
free, either make the repo public or download the `storybook-static` artifact
from the workflow run. Chromatic (free tier) is an alternative host.

## Structure

```
brand-book/
├── .storybook/            Storybook config (main.js, preview.js)
├── src/
│   ├── styles/
│   │   ├── tokens.css      brand tokens as CSS variables (mirrors tokens/tokens.json)
│   │   └── brand.css       component + specimen styles, token-driven
│   ├── lib/mark.js         the "House Record" mark + lockups, one definition
│   ├── Introduction.mdx    overview + the logo-is-the-mark principle
│   ├── brand/              Logo, Colour, Typography (stories) · Voice (mdx)
│   └── components/         Button, Status & party, Form field, Record
└── public/logos/          the SVG masters (icon.svg, icon-dark.svg)
```

## Tokens

`src/styles/tokens.css` mirrors `tokens/tokens.json` at the repo root. Once the
design-system tooling (PR #1) is merged, `npm run tokens` can emit straight into
this file so there is a single source — until then, keep the values in sync.
