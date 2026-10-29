# KhatamRouter Docs

Documentation site for [KhatamRouter](https://github.com/rqzbeh/KhatamRouter), built with Next.js static export and deployed to GitHub Pages.

## Local development

```bash
cd gitbook
bun install
bun run dev:bun
```

The dev server runs at http://localhost:3001.

## Build

```bash
cd gitbook
bun run build:bun
```

The static site is written to `gitbook/out`.

## Deployment

`.github/workflows/gitbook-pages.yml` builds the static export and publishes it to GitHub Pages on every push to `master`/`main` that touches `gitbook/**`, and on manual dispatch.

The Pages site is served from:

https://rqzbeh.github.io/KhatamRouter/

Content lives in `gitbook/content/<lang>/`, with navigation and labels defined in `gitbook/constants/docsConfig.js`. Supported languages: `en`, `es`, `ja`, `vi`, `zh-CN`.
