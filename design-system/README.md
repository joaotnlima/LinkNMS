# LinkNMS — Design system

The source of truth for the identity's **tokens** and **logo assets**, and the
pipeline that regenerates everything from them. Edit the source, run a script,
and the brand-book and the product follow — no manual reprocessing.

```
SOURCE (you edit)              BUILD (generated, committed)
─────────────────              ────────────────────────────
tokens.json      ──tokens──►   cowork/design/brand-book/tokens.css   (interim static book)
                               brand-book/src/styles/tokens.css       (Storybook, live on Vercel)
cowork/design/logos/icon.svg ──icons──► cowork/design/brand-kit/icon/*  (mark only, no text)
```

## Commands

```bash
cd design-system
npm install        # once (sharp, svgo, png-to-ico)
npm run tokens     # tokens.json → tokens.css in every consumer
npm run icons      # logos/icon.svg → brand-kit/icon/*
npm run build      # both
```

`npm run tokens` has **no dependencies** and works before `npm install`.
`npm run icons` needs the dev dependencies.

## Updating

| To change… | Edit… | Then |
|---|---|---|
| A colour / type / spacing token | `design-system/tokens.json` | `npm run tokens` |
| The logo mark | `cowork/design/logos/icon.svg` | `npm run icons` |
| A lockup (name/slogan) | `cowork/design/logos/logo-*.svg` | commit the SVG (masters are the source) |

Tokens are emitted to every consumer from one file, so a hex changed here flows
to both the static brand-book and the Storybook. Commit the regenerated
`tokens.css` files (the Storybook build on Vercel uses the committed copy).

## Deployment

The browsable brand-book is the **Storybook** in [`../brand-book`](../brand-book),
deployed on **Vercel** (repo stays private). There is no GitHub Actions/Pages
workflow — Vercel builds and serves it on every push.

## Growing this later

This intentionally stays tiny. When the web app and a real component library
exist, layer on the standard tools without changing `tokens.json`:

- **Style Dictionary** / **Terrazzo** — emit a Tailwind preset, iOS/Android,
  etc. from the same tokens.
- **Storybook** already hosts the components in `../brand-book`.
- **zeroheight** / **Supernova** — hosted, low-code guidelines if a
  non-developer should maintain the book.
