# LinkNMS — Design assets

The **logo is the mark** (the "House Record" icon). The name and the
*Trust built-in.* slogan are added only where a surface needs them — each
context decides whether to show the name and in which arrangement
(horizontal or stacked). See the root `BRAND.md` for the identity system.

## Structure

```
design/
├── logos/            ← SVG masters (single source of truth, editable)
│   ├── icon.svg              · the mark, on light surfaces
│   ├── icon-dark.svg         · the mark, on dark surfaces
│   ├── logo-horizontal.svg   · icon + name + slogan, side by side
│   ├── logo-horizontal-dark.svg
│   ├── logo-stacked.svg      · icon above name + slogan
│   └── logo-stacked-dark.svg
│
├── brand-kit/        ← ready-to-use exports derived from logos/
│   ├── icon/                 · the mark only, NO text
│   │   ├── icon-16…1024.png, icon-512.webp, favicon.ico
│   │   └── icon-mono-black.svg, icon-mono-white.svg
│   ├── logo-horizontal/      · logo-horizontal-800w/400w.png + mono SVGs
│   ├── logo-stacked/         · logo-stacked-800w/400w.png + mono SVGs
│   └── social/               · og-image, twitter-header, github-social-preview
│
├── marketing-site/   ← marketing site design notes
└── web-app/          ← web app design notes
```

## Which asset to use

| Need | Use |
| --- | --- |
| App icon, favicon, avatar | `brand-kit/icon/` (or `logos/icon.svg`) |
| Header / nav lockup | `logos/logo-horizontal.svg` or `brand-kit/logo-horizontal/` |
| Cover / footer / narrow lockup | `logos/logo-stacked.svg` or `brand-kit/logo-stacked/` |
| Single-colour / print | the `*-mono-black.svg` / `*-mono-white.svg` in each folder |
| Social share images | `brand-kit/social/` |

Colours: Owner Blue `#2a78d6`, Builder Orange `#eb6834`, Ink `#0b0b0b`,
Paper `#fcfcfb`. Slogan fade: "Trust" in Ink, "built-in." in `#9a9a9a`
(light) / `#8c8c8c` (dark).

The colour vector masters live once in `logos/`; `brand-kit/` holds only
derived formats (rasters, mono, social) to avoid duplication. The SVG
masters use the brand's system-sans stack, so they render correctly
without bundling a font.
