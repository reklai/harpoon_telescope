# Harpoon Telescope — Browser Extension

A **ThePrimeagen Harpoon + Telescope** inspired browser extension for blazing-fast tab navigation with optional vim motions. Works on **Firefox**, **Chrome**, and **Zen** (Firefox fork).

## Features

### Telescope Search
- **Search in Page** (`Alt+F`) — full-text fuzzy search across the active page
- **Live preview pane** — shows matched line with surrounding context
- **Combinable structural filters** — `/code`, `/headings`, `/img`, `/links` narrow results by element type
  - Filters combine as union: `/code /links api` searches code blocks AND links for "api"
  - Backspace on empty input removes the last active filter pill
- **Element type badges** — each result shows its source tag (e.g. `[PRE]`, `[H2]`, `[A]`) with color coding
- **Match count** in title bar
- **Code block line splitting** — `<pre>` blocks are split into individual searchable lines
- **Page size safety guard** — pages with >200k DOM elements or >10MB text show a toast and bail

### Tab Manager (Harpoon)
- **Anchor up to 4 tabs** to your harpoon list
- **Remembers scroll position (X, Y)** — restores exactly where you left off
- **Swap mode** (`w`) — stays active after a swap; press another slot to keep swapping, `w` or `Esc` to exit
- **Sessions** — save (`s`), load (`l`), and delete named harpoon sessions (max 4)
  - Duplicate session names rejected (case-insensitive)
  - Identical session content rejected (compares URL arrays)
  - Cannot save an empty harpoon list
- **Cycle through slots** with `Alt+-` (prev) and `Alt+=` (next)
- **Closed tabs persist** — entries dim when a tab is closed, re-open on jump with scroll restore

### Bookmarks
- **`Alt+B`** opens a two-pane bookmark browser with virtual scrolling
- **Type to filter** — fuzzy matching against title, URL, and folder path
- **Slash filters** — `/folder` narrows by folder path
- **Detail pane** — shows title, URL, folder path, date added, domain, and usage score
- **Tree view** (`t`) — full hierarchical folder/bookmark tree with collapse indicators (`▶`/`▼`), j/k cursor navigation, Enter to fold/open
- **Open confirmation** — Enter or double-click on a tree entry shows "Open 'title'?" dialog (y/n)
- **Move bookmark** (`m`) — folder picker to move a bookmark to a different folder, with confirmation
- **Remove bookmark** (`d`) — delete with y/n confirmation
- **Add bookmark** (`Alt+Shift+B`) — three-step wizard: choose File or Folder → pick destination folder → (folder only) enter name
- **Tab pane switching** — Tab key cycles between search input and results list

### History
- **`Alt+Y`** opens a two-pane history browser with virtual scrolling (max 200 entries)
- **Type to filter** — fuzzy matching against title and URL
- **Slash filters** — `/hour`, `/today`, `/week`, `/month` narrow by time range
- **Detail pane** — shows title, URL, domain, visit count, last visit time, and first visit time
- **Tree view** (`t`) — time-bucketed tree (Today / Yesterday / This Week / Last Week / This Month / Older) with entries nested inside, collapse indicators, j/k cursor navigation
- **Open confirmation** — Enter or double-click on a tree entry shows "Open 'title'?" dialog with domain shown underneath (y/n)
- **Remove history entry** (`d`) — delete with y/n confirmation
- **Tab pane switching** — Tab key cycles between search input and results list

### Frecency Tab List
- **`Alt+Shift+F`** opens a frecency-scored list of all open tabs
- **Type to filter** — fuzzy matching against title and URL
- **Tab key** cycles between search input and results list
- **Max 50 entries** — lowest-scored entry evicted when full

### Help Menu
- **`Alt+M`** opens a quick reference overlay showing all keybindings and features
- Sections include panel-specific actions and filter cheatsheets
- Reflects current (possibly customized) keybindings live
- Scroll to browse, Esc to close

### Navigation Modes
- **Basic** (default) — arrow keys, mouse
- **Vim-enhanced** (`Alt+V` to toggle) — adds j/k on top of basic keys
- Green **vim** badge in titlebar of all panels shows current mode

| Action | Basic Mode | Vim Mode (adds) |
|--------|-----------|-----------------|
| Navigate results | Arrow Up/Down | j/k |
| Jump to selected | Enter | Enter |
| Remove (harpoon/bookmark/history) | d | d |
| Swap mode (harpoon) | w | w |
| Move bookmark | m | m |
| Toggle tree view | t | t |
| Save session | s | s |
| Load session | l | l |
| Cycle input / results | Tab | Tab |
| Close overlay | Esc | Esc |

### Keyboard Shortcuts
| Shortcut | Action |
|----------|--------|
| `Alt+T` | Open Tab Manager (Harpoon) |
| `Alt+Shift+T` | Add current tab to harpoon |
| `Alt+1` — `Alt+4` | Jump to harpoon slot 1–4 |
| `Alt+-` | Cycle to previous harpoon slot |
| `Alt+=` | Cycle to next harpoon slot |
| `Alt+F` | Search in current page (Telescope) |
| `Alt+Shift+F` | Open frecency tab list |
| `Alt+B` | Open bookmarks browser |
| `Alt+Shift+B` | Add bookmark (current page or new folder) |
| `Alt+Y` | Open history browser |
| `Alt+M` | Open help menu |
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

Chrome MV3 only allows 4 registered `commands`. The primary shortcuts (open harpoon, add tab, search page) are registered as commands. Everything else (slot jumps, cycling, frecency, bookmarks, history, help, vim toggle) is handled by a `keydown` listener in the content script.

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
│   ├── entrypoints/                        # Browser-executed entry bundles
│   │   ├── background/background.ts        # Background state + message router
│   │   ├── content-script/content-script.ts
│   │   ├── options-page/
│   │   │   ├── options-page.ts
│   │   │   ├── options-page.html
│   │   │   └── options-page.css
│   │   └── toolbar-popup/
│   │       ├── toolbar-popup.ts
│   │       ├── toolbar-popup.html
│   │       └── toolbar-popup.css
│   ├── lib/                                # Feature modules + shared utilities
│   │   ├── appInit/
│   │   ├── addBookmark/
│   │   ├── bookmarks/
│   │   ├── help/
│   │   ├── history/
│   │   ├── searchCurrentPage/
│   │   ├── searchOpenTabs/
│   │   ├── tabManager/
│   │   └── shared/
│   ├── icons/
│   └── types.d.ts
├── esBuildConfig/                          # Build script + MV2/MV3 manifests
├── package.json
├── tsconfig.json
└── dist/                                   # Build output loaded by browser
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                background.js                          │
│   tab manager + sessions + frecency + bookmarks      │
│   + history + message routing                         │
└───────────────┬──────────────────────┬────────────────┘
                │                      │
      runtime messages          runtime messages
                │                      │
   ┌────────────▼──────────┐   ┌──────▼───────────────┐
   │ content-script.js     │   │ options-page.js      │
   │ overlay UI + keybinds │   │ keybinding editor    │
   │ + page grep + preview │   │ + nav mode settings  │
   └────────────┬──────────┘   └──────────────────────┘
                │
        opens/jumps tabs
                │
       ┌────────▼─────────┐
       │ toolbar-popup.js │
       │ quick tab actions│
       └──────────────────┘
```

### Key Design Decisions
- **Shadow DOM** — overlays are injected as Shadow DOM elements to prevent style leakage from host pages
- **webextension-polyfill** — unified `browser.*` API across Chrome and Firefox
- **Dual manifests** — MV2 for Firefox/Zen, MV3 for Chrome (service worker, 4-command limit)
- **`ensureTabManagerLoaded()` guards** — state is lazily reloaded when background context is cold-started
- **Configurable keybindings** — all bindings in `browser.storage.local` with per-scope collision detection
- **Navigation modes** — vim mode adds aliases on top of basic keys (never replaces)
- **rAF-throttled rendering** — frecency, telescope, bookmark, and history defer DOM updates to animation frames
- **Virtual scrolling** — telescope, bookmark, and history results render only ~25 visible items from a pool
- **Tree views** — bookmark and history overlays provide hierarchical navigation with collapse/expand and confirmation flows

## Storage Keys

| Key | Type | Description |
|-----|------|-------------|
| `tabManagerList` | `TabManagerEntry[]` | Active tab manager slots (`closed` entries preserved) |
| `tabManagerSessions` | `TabManagerSession[]` | Saved sessions (max 4) |
| `frecencyData` | `FrecencyEntry[]` | Frecency visit history (max 50) |
| `bookmarkUsage` | `Record<string, BookmarkUsage>` | Per-URL bookmark usage counts and recency |
| `keybindings` | `KeybindingsConfig` | User keybindings + navigation mode |

## Contributing

See `CONTRIBUTING.md` for naming conventions, module boundaries, and PR checklist.

## Theme

Styled with a **macOS Terminal.app** aesthetic — red traffic light dot, clean dark backgrounds (`#1e1e1e`, `#252525`, `#3a3a3c`), accent color `#0a84ff`, monospace font stack.

## License

MIT
