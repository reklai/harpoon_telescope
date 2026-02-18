# Harpoon Telescope — Browser Extension

A **ThePrimeagen Harpoon + Telescope** inspired browser extension for blazing-fast tab navigation with optional vim motions. Works on **Firefox**, **Chrome**, and **Zen** (Firefox fork).

## Features

### Telescope Search
- **Search in Page** (`Alt+F`) — full-text fuzzy search across the active page
- **Live preview pane** — shows matched line with surrounding context
- **Combinable structural filters** — `/code`, `/headings`, `/links` narrow results by element type
  - Filters combine as union: `/code /links api` searches code blocks AND links for "api"
  - Backspace on empty input removes the last active filter pill
- **Element type badges** — each result shows its source tag (e.g. `[PRE]`, `[H2]`, `[A]`) with color coding
- **Match count** in title bar
- **Code block line splitting** — `<pre>` blocks are split into individual searchable lines
- **Page size safety guard** — pages with >200k DOM elements or >10MB text show a toast and bail

### Harpoon Tab Anchoring
- **Anchor up to 6 tabs** to your harpoon list
- **Remembers scroll position (X, Y)** — restores exactly where you left off
- **Swap mode** (`w`) — stays active after a swap; press another slot to keep swapping, `w` or `Esc` to exit
- **Sessions** — save (`s`), load (`l`), and delete named harpoon sessions (max 3)
  - Duplicate session names rejected (case-insensitive)
  - Identical session content rejected (compares URL arrays)
  - Cannot save an empty harpoon list
- **Cycle through slots** with `Alt+-` (prev) and `Alt+=` (next)
- **Closed tabs persist** — entries dim when a tab is closed, re-open on jump with scroll restore

### Frecency Tab List
- **`Alt+Y`** opens a frecency-scored list of all open tabs
- **Type to filter** — fuzzy matching against title and URL
- **Tab key** cycles between search input and results list
- **Max 50 entries** — lowest-scored entry evicted when full

### Navigation Modes
- **Basic** (default) — arrow keys, PageUp/PageDown, mouse
- **Vim-enhanced** (`Alt+V` to toggle) — adds j/k, Ctrl+U/D on top of basic keys
- Green **vim** badge in titlebar of all panels shows current mode

| Action | Basic Mode | Vim Mode (adds) |
|--------|-----------|-----------------|
| Navigate results | Arrow Up/Down | j/k |
| Scroll preview | PageUp/PageDown | Ctrl+U/D |
| Jump to selected | Enter | Enter |
| Remove (harpoon) | d | d |
| Swap mode (harpoon) | w | w |
| Save session | s | s |
| Load session | l | l |
| Cycle input / results | Tab | Tab |
| Close overlay | Esc | Esc |

### Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| `Alt+M` | Open Harpoon panel |
| `Alt+A` | Add current tab to harpoon |
| `Alt+1` — `Alt+6` | Jump to harpoon slot 1–6 |
| `Alt+-` | Cycle to previous harpoon slot |
| `Alt+=` | Cycle to next harpoon slot |
| `Alt+F` | Search in current page (Telescope) |
| `Alt+Y` | Open frecency tab list |
| `Alt+V` | Toggle vim motions globally |

All keybindings are fully configurable in the extension options page with per-scope collision detection.

## Build

TypeScript source in `src/` is compiled to `dist/` via esbuild. The `--target` flag controls which manifest is used:

| Command | Target | Manifest |
|---------|--------|----------|
| `npm run build` | Firefox (default) | `manifest_v2.json` (MV2) |
| `npm run build:firefox` | Firefox / Zen | `manifest_v2.json` (MV2) |
| `npm run build:chrome` | Chrome | `manifest_v3.json` (MV3) |

Watch mode rebuilds on file changes:

```sh
npm run watch            # firefox (default)
npm run watch:chrome     # chrome
```

Other scripts:

```sh
npm run typecheck        # tsc --noEmit
npm run clean            # rm -rf dist
```

The JS bundles are identical across targets — `webextension-polyfill` handles API differences at runtime. Only the manifest differs (MV2 vs MV3).

### Chrome's 4-command limit

Chrome MV3 only allows 4 registered `commands`. The primary shortcuts (open harpoon, add tab, search page) are registered as commands. Everything else (slot jumps, cycling, frecency, vim toggle) is handled by a `keydown` listener in the content script.

## Installation (Development)

### Firefox / Zen
1. Run `npm run build:firefox`
2. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on**
3. Select `dist/manifest.json`

### Chrome
1. Run `npm run build:chrome`
2. Open `chrome://extensions` → enable **Developer mode**
3. Click **Load unpacked** → select the `dist/` folder

## Project Structure

```
harpoon_telescope/
├── src/
│   ├── background.ts               # Harpoon state, tab events, session mgmt, message router
│   ├── content-script.ts           # Global keybinds, message handler, overlay injection
│   ├── types.d.ts                  # Shared type declarations
│   ├── manifest_v2.json            # Firefox/Zen manifest (MV2)
│   ├── manifest_v3.json            # Chrome manifest (MV3, service worker, 4-command limit)
│   ├── lib/
│   │   ├── keybindings.ts          # Keybinding defaults, vim aliases, collision detection, matching
│   │   ├── helpers.ts              # escapeHtml, escapeRegex, extractDomain
│   │   ├── panel-host.ts           # Shadow DOM host, focus trapping, base styles, vim badge
│   │   ├── grep.ts                 # DOM tree walker, structural filters, fuzzy scoring
│   │   ├── scroll.ts               # Scroll-to-text with highlight removal
│   │   ├── feedback.ts             # Center-screen toast notifications
│   │   ├── harpoon-overlay.ts      # Harpoon panel (list, swap, keybinds)
│   │   ├── search-overlay.ts       # Telescope search (input, results, preview, virtual scroll)
│   │   ├── frecency-overlay.ts     # Frecency tab list (filter, Tab cycling, rAF rendering)
│   │   ├── frecency.ts             # Frecency scoring, max 50 with lowest-score eviction
│   │   ├── sessions.ts             # Session CRUD with duplicate rejection
│   │   └── session-views.ts        # Session save/load/delete/restore UI
│   ├── popup/
│   │   ├── popup.ts                # Toolbar popup logic
│   │   ├── popup.html
│   │   └── popup.css
│   ├── options/
│   │   ├── options.ts              # Settings page (keybindings, nav mode toggle)
│   │   ├── options.html
│   │   └── options.css
│   └── icons/
│       ├── icon-48.png
│       └── icon-96.png
├── build.mjs                       # esbuild bundler (--target firefox|chrome)
├── package.json
├── tsconfig.json                   # ES2022 target
└── dist/                           # Build output (loaded by browser)
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│               background.ts                       │
│  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Harpoon Mgr  │  │ Message Router           │  │
│  │ - 6 slots    │  │ - routes to content       │  │
│  │ - scroll mem │  │   script handlers         │  │
│  │ - sessions   │  │ - serves keybindings      │  │
│  │ - frecency   │  │ - frecency list           │  │
│  └──────────────┘  └──────────────────────────┘  │
└────────┬──────────────────────┬──────────────────┘
         │ messages              │ messages
  ┌──────▼──────────┐    ┌──────▼───────────────┐
  │ content-script  │    │ options page          │
  │ - grep page     │    │ - keybinding editor   │
  │ - scroll r/w    │    │ - nav mode toggle     │
  │ - harpoon UI    │    │ - collision detection  │
  │   (Shadow DOM)  │    └──────────────────────┘
  │ - telescope UI  │
  │   (Shadow DOM)  │
  │ - frecency UI   │
  │   (Shadow DOM)  │
  └─────────────────┘
```

### Key Design Decisions
- **Shadow DOM** — overlays are injected as Shadow DOM elements to prevent style leakage from host pages
- **webextension-polyfill** — unified `browser.*` API across Chrome and Firefox
- **Dual manifests** — MV2 for Firefox/Zen, MV3 for Chrome (service worker, 4-command limit)
- **ensureHarpoonLoaded()** — lazy-load guard for Chrome service workers that can terminate
- **Configurable keybindings** — all bindings in `browser.storage.local` with per-scope collision detection
- **Navigation modes** — vim mode adds aliases on top of basic keys (never replaces)
- **rAF-throttled rendering** — frecency and telescope defer DOM updates to animation frames
- **Virtual scrolling** — telescope results render only ~25 visible items from a pool

## Storage Keys

| Key | Type | Description |
|-----|------|-------------|
| `harpoonList` | `HarpoonEntry[]` | Active harpoon slots (with `closed` flag) |
| `harpoonSessions` | `HarpoonSession[]` | Saved sessions (max 3) |
| `frecencyData` | `FrecencyEntry[]` | Frecency visit history (max 50) |
| `keybindings` | `KeybindingsConfig` | User keybindings + navigation mode |

## Theme

Styled with a **macOS Terminal.app** aesthetic — red traffic light dot, clean dark backgrounds (`#1e1e1e`, `#252525`, `#3a3a3c`), accent color `#0a84ff`, monospace font stack.

## License

MIT
