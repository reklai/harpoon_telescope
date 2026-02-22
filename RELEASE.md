# Release Runbook

This file defines how to produce reproducible extension artifacts from source.

## Environment Requirements

- OS: Linux, macOS, or Windows
- Node.js: `v21.7.0` (or compatible Node 21.x)
- npm: `10.5.0` (or compatible npm 10.x)
- `zip` CLI available in `PATH`

## Install Dependencies

```sh
npm ci
```

## Build Targets

- Firefox/Zen (MV2): `npm run build:firefox`
- Chrome (MV3): `npm run build:chrome`

Both targets are built from the same TypeScript source. Manifest selection is target-specific.

## Quality Gate

Run before packaging:

```sh
npm run ci
```

This includes lint, tests, typecheck, compatibility checks, upgrade checks, store-policy checks, and both target builds.

## Package Artifacts

```sh
VERSION=$(node -p "require('./package.json').version")
mkdir -p release

# Firefox package
npm run build:firefox
(cd dist && zip -qr "../release/harpoon-telescope-firefox-v${VERSION}.xpi" .)

# Chrome package
npm run build:chrome
(cd dist && zip -qr "../release/harpoon-telescope-chrome-v${VERSION}.zip" .)
```

## Source Archive (Reviewer Repro)

Use a clean source archive that excludes generated and dependency directories:

```sh
VERSION=$(node -p "require('./package.json').version")
mkdir -p release
zip -qr "release/harpoon-telescope-source-v${VERSION}.zip" . \
  -x ".git/*" "dist/*" "node_modules/*" "release/*"
```

## Build Pipeline Entry Point

- `esBuildConfig/build.mjs`

Pipeline responsibilities:

1. Bundle TypeScript entry points (background/content/options/popup) with esbuild.
2. Copy static assets (manifest, HTML, CSS, icons) into `dist/`.
3. Target-select manifest (`manifest_v2.json` or `manifest_v3.json`).

## Reproducibility Notes

- Builds are not minified (`minify: false`).
- Source maps are disabled for packaged output (`sourcemap: false`).
- Runtime API parity is handled with `webextension-polyfill`.
