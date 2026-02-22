# TabScope — Browser Extension

ThePrimeagen Harpoon + Telescope inspired browser extension for fast, keyboard-first driven (mouse supported out-of-box) tab navigation on Firefox, Chrome (Experimental), and Zen.

## What It Does

- Tab Manager (Harpoon): anchor up to 4 tabs and jump instantly with scroll-position memory.
- Sessions: save/load up to 4 tab-manager session sets.
- Search Current Page (Telescope): fuzzy in-page search with filters and live preview.
- Search Open Tabs: fuzzy current open tabs sorted by frequency+recently-opened tab jumping.
- Keybinding customization: configurable global and panel bindings.

## Feature Snapshot

### Search Current Page

- Open with `Alt+F`.
- Fuzzy search across page text with filters: `/code`, `/headings`, `/img`, `/links`.
- Live preview pane with context and highlighted matches.
- `Shift+Space` clears search input.

### Tab Manager (Harpoon)

- Anchor up to 4 tabs to numbered slots.
- Jump/cycle with scroll restoration on reopen.
- Swap mode (`W`), delete (`D`), undo remove (`U`).

### Sessions

- `Alt+S` opens load view.
- `Alt+Shift+S` opens save view directly.
- Save/load up to 4 named sessions.
- Includes overwrite/delete/load confirmations and session preview.

### Search Open Tabs (Frecency)

- Open with `Alt+Shift+F`.
- Fuzzy search over open tab title + URL.
- Ranked by recency/frequency score.

### Help + Navigation

- `Alt+M` opens the help overlay.
- Standard navigation mode always on (`j/k` aliases + arrow keys).
- Half-page jumps in list views: `Ctrl+D` / `Ctrl+U`.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+T` | Open Tab Manager (Harpoon) |
| `Alt+Shift+T` | Add current tab to harpoon |
| `Alt+1` — `Alt+4` | Jump to harpoon slot 1–4 |
| `Alt+-` | Cycle to previous harpoon slot |
| `Alt+=` | Cycle to next harpoon slot |
| `Alt+F` | Search in current page (Telescope) |
| `Alt+Shift+F` | Open frecency tab list |
| `Alt+S` | Open session menu |
| `Alt+Shift+S` | Open save session |
| `Alt+M` | Open help menu |

Global and panel keybindings are configurable in the extension options page with per-scope collision detection.

## Quick Start (Development)

### Firefox / Zen

1. `npm run build:firefox`
2. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on**
3. Select `dist/manifest.json`

### Chrome

1. `npm run build:chrome`
2. Open `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and select `dist/`

## Build And Test

Build targets:

| Command | Target | Manifest |
|---------|--------|----------|
| `npm run build` | Firefox (default) | `manifest_v2.json` |
| `npm run build:firefox` | Firefox / Zen | `manifest_v2.json` |
| `npm run build:chrome` | Chrome | `manifest_v3.json` |

Core verification commands:

```sh
npm run lint
npm run test
npm run typecheck
npm run verify:compat
npm run verify:upgrade
npm run verify:store
npm run ci
```

## Promise to myself

- Keyboard-first workflows stay predictable across all panels.
- Native browser primitives first (Shadow DOM + WebExtension APIs).
- Firefox/Chrome parity is maintained through shared contracts and adapters.
- Reliability guardrails (tests + compat/store checks) are part of release quality.

Quick path:

```sh
npm ci
npm run clean
npm run build:firefox
VERSION=$(node -p "require('./package.json').version")
mkdir -p release
(cd dist && zip -qr "../release/harpoon-telescope-firefox-v${VERSION}.xpi" .)
```

## Docs Map

- Build/release runbook and reproducible packaging: `RELEASE.md`
- Store metadata/policy reference: `STORE.md`
- Privacy policy: `PRIVACY.md`

## Project Structure

```text
harpoon_telescope/
├── src/
│   ├── entryPoints/                # background/content/options/popup bundles
│   ├── lib/                        # appInit, adapters, core, ui, common, backgroundRuntime
│   ├── icons/
│   └── types.d.ts
├── esBuildConfig/                  # build scripts + MV2/MV3 manifests
├── test/                           # node:test guardrails
├── RELEASE.md
├── STORE.md
├── PRIVACY.md
└── README.md
```

## License

MIT — see `LICENSE`.
