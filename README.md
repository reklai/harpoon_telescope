# Harpoon Telescope — Browser Extension

A **ThePrimeagen Harpoon + Telescope** inspired browser extension for blazing-fast keyboard-first tab navigation. Works on **Firefox**, **Chrome**, and **Zen** (Firefox fork).

## Current Product Priority (Release Gate)

- Primary goal: Tab Manager + Session Manager must be fast, stable, and predictable under real rapid usage.
- Must pass rapid-switch stress (`Alt+1..4`, `Alt+-`, `Alt+=`) with no UI lockups, missed jumps, or panel freeze.
- Must restore saved scroll location reliably on jump, reopen, and session load (including reused tabs).
- Store publishing happens only after this reliability gate is signed off on both Firefox and Chrome builds.

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
- **Shift+Space clear-search** — clears the query from any pane

### Tab Manager (Harpoon)
- **Anchor up to 4 tabs** to your harpoon list
- **Remembers scroll position (X, Y)** — restores exactly where you left off
- **Swap mode** (`W` default) — stays active after a swap; press another slot to keep swapping, `W` or close key to exit
- **Undo last remove** (`U` default) — restores the most recently removed slot when space is available
- **Cycle through slots** with `Alt+-` (prev) and `Alt+=` (next)
- **Closed tabs persist** — entries dim when a tab is closed, re-open on jump with scroll restore
  - Tab Manager footer action hints: `U undo` · `W swap` · `D del` · `Enter jump` · `Esc close`

### Session Menu
- **`Alt+S`** opens the dedicated session menu
- **Main view is load sessions** — searchable list with preview
- **`Alt+Shift+S`** opens save-session flow directly
- **`Enter`** loads the selected session (confirmation shown first)
  - Session list includes a preview pane showing tabs in the selected profile
  - `D` (or `×`) prompts delete confirmation in preview (`Y` delete / `N` cancel)
  - `O` prompts overwrite confirmation in preview (`Y` overwrite / `N` cancel)
  - `R` renames the selected session inline
  - Session search uses `Search Sessions . . .` with `Shift+Space clear-search`
  - Save-session view shows a name input and the current Tab Manager tab preview
  - Duplicate-name validation is inline in the save panel
  - Identical-content save attempts are pre-guarded before open with toast: `No changes to save, already saved as "<name>"`
  - Session load confirmation shows a minimal slot plan legend: `NEW (+)`, `DELETED (-)`, `REPLACED (~)`, `UNCHANGED (=)`
  - Duplicate session names rejected (case-insensitive)
  - Identical session content rejected (compares URL arrays)
  - Cannot save an empty harpoon list

### Frecency Tab List
- **`Alt+Shift+F`** opens a frecency-scored list of all open tabs
- **Type to search** — fuzzy matching against title and URL
- **Tab key** cycles between search input and results list
- **Shift+Space clear-search** clears the query
- **Max 50 entries** — lowest-scored entry evicted when full

### Help Menu
- **`Alt+M`** opens a quick reference overlay showing all keybindings and features
- Sections include panel-specific actions and filter cheatsheets
- Reflects current (possibly customized) keybindings live
- Scroll to browse, Esc to close

### Navigation Mode
- Standard navigation is always enabled
- `j/k` up/down aliases are always on (additive with configured arrow bindings)
- List-focused overlays support fixed `Ctrl+D/U` half-page jumps

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
| `Alt+S` | Open session menu |
| `Alt+Shift+S` | Open save session |
| `Alt+M` | Open help menu |
All keybindings are fully configurable in the extension options page with per-scope collision detection.

### Keybinding Scope Coverage
- Configurable (single source of truth in `src/lib/shared/keybindings.ts`): global open commands, tab manager panel actions, search panel actions, and session panel actions.
- Not currently configurable (fixed behavior): `j/k` standard aliases, `Ctrl+D/U` half-page jumps, mouse click/wheel interactions, text-edit keys (Backspace/Delete/etc inside inputs).

## Engineering Promise

- Ghostty-inspired UX with fast keyboard-first workflows.
- Native browser primitives first: Shadow DOM, DOM APIs, and WebExtension APIs over UI frameworks.
- Cross-platform parity between Firefox/Zen and Chrome targets.
- Minimal UI glitching through guarded panel lifecycle, responsive layout, and perf instrumentation.

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
npm run lint             # lightweight repository lint checks
npm run test             # node:test suite (manifest/docs guardrails)
npm run typecheck        # tsc --noEmit
npm run verify:compat    # manifest + permission sanity checks
npm run verify:upgrade   # fixture-based storage migration compatibility checks
npm run verify:store     # manifest/store/privacy policy consistency checks
npm run ci               # lint + test + typecheck + compat + upgrade + store + both builds
npm run clean            # rm -rf dist
```

The JS bundles are identical across targets — `webextension-polyfill` handles API differences at runtime. Only the manifest differs (MV2 vs MV3).

### Command Registration Strategy

Chrome MV3 only supports up to 4 suggested command shortcuts. The manifest keeps only core shortcuts (`open`, `add`, `search`), and the content script handles slot jumps, cycling, standard aliases, and panel-local actions so behavior stays consistent across Firefox, Chrome, and Zen.

### Release Flow

1. Pass the Tab Manager/Session Manager reliability gate first: rapid-switch stability, consistent panel open behavior, and correct scroll restore on jump/reopen/session load.
2. If permissions, storage limits, or privacy claims changed, update `manifest_v2.json`, `manifest_v3.json`, `STORE.md`, and `PRIVACY.md` together in the same PR.
3. Run `npm run ci` before tagging a release. This includes `npm run verify:upgrade` and `npm run verify:store`, which block releases on migration regressions or manifest/docs/privacy-policy drift.
4. Build the target package (`npm run build:firefox` and/or `npm run build:chrome`) and use `STORE.md` + `PRIVACY.md` as the source of truth for store submission text.

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
│   ├── entryPoints/                        # Browser-executed entry bundles
│   │   ├── background/background.ts        # Background bootstrap + router composition
│   │   ├── contentScript/contentScript.ts
│   │   ├── optionsPage/
│   │   │   ├── optionsPage.ts
│   │   │   ├── optionsPage.html
│   │   │   └── optionsPage.css
│   │   └── toolbarPopup/
│   │       ├── toolbarPopup.ts
│   │       ├── toolbarPopup.html
│   │       └── toolbarPopup.css
│   ├── lib/                                # Feature modules + shared utilities
│   │   ├── appInit/
│   │   ├── adapters/
│   │   │   └── runtime/                    # Single runtime-message boundary layer
│   │   ├── background/                     # Background domains + message/command routers
│   │   ├── core/
│   │   │   ├── panel/                      # Shared list-navigation controller
│   │   │   └── sessionMenu/                # Pure session state machine + selectors
│   │   ├── ui/
│   │   │   ├── panels/
│   │   │   │   ├── help/
│   │   │   │   ├── searchCurrentPage/
│   │   │   │   ├── searchOpenTabs/
│   │   │   │   ├── sessionMenu/            # Session overlays (load/save/restore)
│   │   │   │   └── tabManager/             # Tab Manager overlay (slots/swap/undo/remove)
│   │   │   └── shared/                     # Panel host + preview shell styles
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
│   tab manager + sessions + frecency                  │
│   + message routing                                   │
└───────────────┬──────────────────────┬────────────────┘
                │                      │
      runtime messages          runtime messages
                │                      │
   ┌────────────▼──────────┐   ┌──────▼───────────────┐
   │ contentScript.js      │   │ optionsPage.js      │
   │ overlay UI + keybinds │   │ keybinding editor    │
   │ + action registry     │   │ + nav mode settings  │
   │ + page grep + preview │   │                      │
   └────────────┬──────────┘   └──────────────────────┘
                │
        opens/jumps tabs
                │
       ┌────────▼─────────┐
       │ toolbarPopup.js │
       │ quick tab actions│
       └──────────────────┘
```

### Key Design Decisions
- **Shadow DOM** — overlays are injected as Shadow DOM elements to prevent style leakage from host pages
- **webextension-polyfill** — unified `browser.*` API across Chrome and Firefox
- **Dual manifests** — MV2 for Firefox/Zen, MV3 for Chrome (service worker lifecycle)
- **Compatibility guardrail** — `npm run verify:compat` checks manifest permission/command invariants
- **Store policy guardrail** — `npm run verify:store` keeps manifests, store copy, and privacy policy aligned
- **Background domain routing** — `background.ts` is orchestration; tab manager/session handlers live in `src/lib/background/*`
- **`ensureTabManagerLoaded()` guards** — tab manager state is lazily reloaded when background context is cold-started
- **Runtime adapter boundary** — runtime message calls are centralized in `src/lib/adapters/runtime/*` so UI modules don't send raw messages directly
- **Pure core modules for UI state** — `src/lib/core/sessionMenu/sessionCore.ts` isolates session transient-state transitions and derived selectors
- **Shared list-navigation engine** — `src/lib/core/panel/panelListController.ts` keeps wheel/arrow/half-page behavior consistent across overlays
- **Configurable keybindings** — all bindings in `browser.storage.local` with per-scope collision detection
- **Navigation behavior** — standard mode is always enabled; `j/k` aliases are additive with base up/down bindings
- **rAF-throttled rendering** — frecency and telescope views defer DOM updates to animation frames
- **Perf regression budgets** — filter/render hotspots use `withPerfTrace` + `src/lib/shared/perfBudgets.json` guardrails
- **Shared design tokens** — overlays consume `panelHost` CSS variables for consistent Ghostty-inspired styling
- **Virtual scrolling** — heavy list panels render only the visible window from a pooled set of DOM nodes

## Storage Keys

| Key | Type | Description |
|-----|------|-------------|
| `tabManagerList` | `TabManagerEntry[]` | Active tab manager slots (`closed` entries preserved) |
| `tabManagerSessions` | `TabManagerSession[]` | Saved sessions (max 4) |
| `frecencyData` | `FrecencyEntry[]` | Frecency ranking data (max 50) |
| `keybindings` | `KeybindingsConfig` | User keybindings + navigation mode |
| `storageSchemaVersion` | `number` | Schema version used by startup migrations |

## Contributing

See `CONTRIBUTING.md` for naming conventions, module boundaries, and PR checklist.
Architecture walkthrough for contributors: `docs/ARCHITECTURE.md`.

## License

MIT
