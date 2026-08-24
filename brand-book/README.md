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

Deployed on **Vercel** (repo stays private). Vercel builds this project on every
push — Root Directory `brand-book`, build `npm run build-storybook`, output
`storybook-static` (pinned in `vercel.json`). No GitHub Actions/Pages.

## Structure

```
brand-book/
├── .storybook/            Storybook config (main.js, preview.js)
├── src/
│   ├── styles/
│   │   ├── tokens.css      brand tokens (generated from design-system/tokens.json)
│   │   └── brand.css       component + specimen styles, token-driven
│   ├── lib/mark.js         the "House Record" mark + lockups, one definition
│   ├── Introduction.mdx    overview + the logo-is-the-mark principle
│   ├── brand/              Logo, Colour, Typography (stories) · Voice (mdx)
│   └── components/         Button, Status & party, Form field, Record
└── public/logos/          the SVG masters (icon.svg, icon-dark.svg)
```

## Tokens

`src/styles/tokens.css` is **generated** from `design-system/tokens.json` — run
`npm run tokens` in [`../design-system`](../design-system) to regenerate it (and
the static book's copy) from the single source. Don't edit it by hand.
