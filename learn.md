# Harpoon Telescope — Complete Implementation Guide

A ground-up walkthrough of every file, every decision, and every pattern in this browser extension. Written so I can rebuild this from scratch, articulate every choice in interviews, and apply these patterns to future projects.

This is not a JavaScript tutorial. It assumes working knowledge of JS/TS, the DOM, async/await, and basic data structures. What it covers is: why the project is structured the way it is, what every config option does, how every module works internally, and what problems each pattern solves.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Project Configuration — package.json](#project-configuration--packagejson)
3. [TypeScript Configuration — tsconfig.json](#typescript-configuration--tsconfigjson)
4. [Build System — build.mjs](#build-system--buildmjs)
5. [Manifests — MV2 and MV3](#manifests--mv2-and-mv3)
6. [Type Declarations — types.d.ts](#type-declarations--typesd-ts)
7. [Architecture — How Extension Contexts Work](#architecture--how-extension-contexts-work)
8. [Content Script — content-script.ts](#content-script--content-scriptts)
9. [Background Script — background.ts](#background-script--backgroundts)
10. [Keybinding System — keybindings.ts](#keybinding-system--keybindingsts)
11. [Panel Host — panel-host.ts](#panel-host--panel-hostts)
12. [Helpers — helpers.ts](#helpers--helpersts)
13. [Feedback — feedback.ts](#feedback--feedbackts)
14. [Fuzzy Search Engine — grep.ts](#fuzzy-search-engine--grepts)
15. [Scroll-to-Text — scroll.ts](#scroll-to-text--scrollts)
16. [Frecency Algorithm — frecency.ts](#frecency-algorithm--frecencyts)
17. [Session Management — sessions.ts](#session-management--sessionsts)
18. [Harpoon Overlay — harpoon-overlay.ts](#harpoon-overlay--harpoon-overlayts)
19. [Telescope Overlay — search-overlay.ts](#telescope-overlay--search-overlayts)
20. [Bookmark Overlay — bookmark-overlay.ts](#bookmark-overlay--bookmark-overlayts)
21. [History Overlay — history-overlay.ts](#history-overlay--history-overlayts)
22. [Frecency Overlay — frecency-overlay.ts](#frecency-overlay--frecency-overlayts)
23. [Help Overlay — help-overlay.ts](#help-overlay--help-overlayts)
24. [Session Views — session-views.ts](#session-views--session-viewsts)
25. [Popup — popup.ts](#popup--popupts)
26. [Options Page — options.ts](#options-page--optionsts)
27. [CSS Architecture](#css-architecture)
28. [Cross-Browser Compatibility](#cross-browser-compatibility)
29. [Performance Patterns](#performance-patterns)
30. [State Management](#state-management)
31. [Event Handling Patterns](#event-handling-patterns)
32. [DOM Rendering Strategies](#dom-rendering-strategies)
33. [Tree Navigation Pattern](#tree-navigation-pattern)
34. [Debugging Lessons](#debugging-lessons)
35. [Patterns Worth Reusing](#patterns-worth-reusing)

---

## Project Overview

This extension brings two Neovim plugins to the browser, plus three browser-data overlays:

- **Harpoon** (ThePrimeagen) — pin a small set of files/buffers and instantly jump between them. Here: pin up to 4 tabs with scroll memory.
- **Telescope** (nvim-telescope) — fuzzy find anything. Here: fuzzy search the current page's visible text with structural filters and a preview pane.
- **Bookmarks** — browse, fuzzy-filter, add/remove/move browser bookmarks with a two-pane layout, folder tree view, and folder picker.
- **History** — browse and fuzzy-filter browser history with time bucket classification, tree view, and in-place deletion.
- **Frecency** — a Mozilla-coined algorithm for ranking items by a combination of frequency and recency, used here for a tab switcher.

The extension runs on Firefox (Manifest V2), Chrome (Manifest V3), and Zen (Firefox fork, inherits MV2 support). Every overlay is a Shadow DOM panel injected into the active page. All keybindings are user-configurable with per-scope collision detection. Navigation modes: basic (arrows) and vim (adds j/k on top of basic).

### File Structure

```
harpoon_telescope/
├── build.mjs                    # esbuild build script (86 lines)
├── package.json                 # project metadata and dependencies (25 lines)
├── tsconfig.json                # TypeScript config — type-checking only (20 lines)
├── learn.md                     # this file
├── README.md                    # user-facing documentation
├── .gitignore                   # git exclusions
├── src/
│   ├── background.ts            # central hub: state, commands, message routing (749 lines)
│   ├── content-script.ts        # per-page entry: key handler, message router (208 lines)
│   ├── types.d.ts               # shared TypeScript interfaces (110 lines)
│   ├── manifest_v2.json         # Firefox/Zen manifest
│   ├── manifest_v3.json         # Chrome manifest
│   ├── icons/
│   │   ├── tab-search.png       # source icon (512x512)
│   │   ├── icon-48.png          # resized for manifest
│   │   ├── icon-96.png          # resized for manifest
│   │   └── icon-128.png         # resized for Chrome Web Store
│   ├── lib/
│   │   ├── keybindings.ts       # config, defaults, matching, collision detection (266 lines)
│   │   ├── panel-host.ts        # Shadow DOM host creation, base styles (131 lines)
│   │   ├── harpoon-overlay.ts   # Tab Manager panel (525 lines)
│   │   ├── search-overlay.ts    # Telescope search panel (850 lines)
│   │   ├── bookmark-overlay.ts  # Bookmark browser (filter, tree, move, add/remove) (1954 lines)
│   │   ├── history-overlay.ts   # History browser (filter, time buckets, tree) (1317 lines)
│   │   ├── frecency-overlay.ts  # Frecency tab list (filter, Tab cycling, rAF) (423 lines)
│   │   ├── help-overlay.ts      # Help menu (fuzzy search, section filters, collapsible) (708 lines)
│   │   ├── session-views.ts     # Session save/load/replace/restore views (593 lines)
│   │   ├── grep.ts              # Fuzzy search engine with line cache (574 lines)
│   │   ├── scroll.ts            # Scroll-to-text with temporary highlight (110 lines)
│   │   ├── frecency.ts          # Frecency scoring algorithm (123 lines)
│   │   ├── sessions.ts          # Session CRUD handlers (100 lines)
│   │   ├── helpers.ts           # escapeHtml, escapeRegex, extractDomain (23 lines)
│   │   └── feedback.ts          # Toast notification system (34 lines)
│   ├── popup/
│   │   ├── popup.ts             # Popup script (94 lines)
│   │   ├── popup.html           # Popup markup
│   │   └── popup.css            # Popup styles
│   └── options/
│       ├── options.ts           # Options page script (207 lines)
│       ├── options.html         # Options page markup
│       └── options.css          # Options page styles
└── dist/                        # build output (gitignored)
```

Total: ~8,000 lines of TypeScript across 17 source files, plus HTML/CSS for popup and options.

---

## Project Configuration — package.json

```json
{
  "name": "harpoon-telescope",
  "version": "2.0.0",
  "private": true,
  "description": "Harpoon + Telescope inspired Firefox extension",
  "scripts": {
    "build": "node build.mjs",
    "build:firefox": "node build.mjs --target firefox",
    "build:chrome": "node build.mjs --target chrome",
    "watch": "node build.mjs --watch",
    "watch:firefox": "node build.mjs --watch --target firefox",
    "watch:chrome": "node build.mjs --watch --target chrome",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "@types/webextension-polyfill": "^0.12.4",
    "esbuild": "^0.24.0",
    "typescript": "^5.7.0"
  },
  "dependencies": {
    "webextension-polyfill": "^0.12.0"
  }
}
```

### Field-by-field breakdown

**`"private": true`** — Prevents accidental `npm publish`. This is a browser extension, not an npm package. Without this flag, `npm publish` would upload it to the public npm registry.

**`"scripts"`** — npm scripts that abstract build commands:

- `build` / `build:firefox` — Runs `build.mjs` targeting Firefox (MV2). This is the default because Firefox was the primary development browser.
- `build:chrome` — Runs `build.mjs` targeting Chrome (MV3). Copies `manifest_v3.json` instead of `manifest_v2.json`.
- `watch` / `watch:firefox` / `watch:chrome` — Same as build but with esbuild's file watcher. Recompiles on every source file change. The `--watch` flag is parsed by `build.mjs`, not esbuild directly.
- `typecheck` — Runs the TypeScript compiler in check-only mode (`--noEmit`). This is separate from the build because esbuild strips types without checking them. You run `typecheck` manually or in CI to catch type errors.
- `clean` — Deletes the `dist/` directory. Useful when switching between Firefox and Chrome targets to avoid stale manifest files.

**`"devDependencies"`** — Tools needed only during development:

- `@types/webextension-polyfill` — TypeScript type definitions for the `webextension-polyfill` package. Without these, every `browser.*` call would be `any`-typed and you'd get no autocomplete or type errors.
- `esbuild` — The bundler. Compiles TypeScript to JavaScript and resolves imports into single files. Written in Go, 10-100x faster than webpack/rollup. We use it because the build script is 86 lines instead of hundreds.
- `typescript` — The TypeScript compiler. Used only for type-checking (via `tsc --noEmit`), never for code generation. esbuild handles all transpilation.

**`"dependencies"`** — Runtime code bundled into the extension:

- `webextension-polyfill` — Wraps Chrome's callback-based `chrome.*` APIs to return Promises via `browser.*`. This lets us write one codebase that works on both Firefox (which natively uses `browser.*` with Promises) and Chrome (which uses `chrome.*` with callbacks). esbuild bundles this into every output JS file — it doesn't ship as a separate file.

### Why no framework?

No React, Vue, Svelte, or any UI framework. Why:

1. **Bundle size** — Frameworks add 30-100KB. The entire extension JS output is smaller than React alone.
2. **Extension constraints** — Content scripts inject into every page. Adding framework overhead to every tab load is wasteful.
3. **Shadow DOM** — Frameworks have varying levels of Shadow DOM support. Vanilla JS gives full control.
4. **Learning value** — Building without frameworks forces understanding of DOM manipulation, event handling, and state management that frameworks abstract away.
5. **Complexity** — The UI is keyboard-driven with simple state. A framework would be overkill.

---

## TypeScript Configuration — tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "rootDir": "src",
    "outDir": "dist",
    "types": ["webextension-polyfill"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### Option-by-option breakdown

**`"target": "ES2022"`**

The JavaScript language version tsc emits. Since we set `noEmit: true` and use esbuild for actual compilation, this primarily affects which built-in type definitions tsc loads. ES2022 includes:
- Top-level `await` (not used, but available)
- `Array.at()` method types
- `Object.hasOwn()` types
- `Error.cause` types
- Class fields and private methods

We chose ES2022 because all modern browsers (Firefox 89+, Chrome 94+) support it natively. No transpilation of modern features to older syntax is needed.

esbuild also targets `es2022` in its config (`target: "es2022"` in `build.mjs`). These should match — if tsconfig targeted ES2024 but esbuild targeted ES2020, tsc would accept syntax that esbuild would reject.

**`"module": "ESNext"`**

Tells tsc to treat source files as ES modules (using `import`/`export`). `ESNext` means "latest module syntax" — in practice, standard ES modules with `import` and `export`. Alternatives:
- `"CommonJS"` — would expect `require()` and `module.exports`. Wrong for us since esbuild handles ES module imports.
- `"ES2022"` — would be fine too, but `ESNext` future-proofs against new module features.

This setting matters because it determines how tsc validates import/export statements. It doesn't affect output since `noEmit: true`.

**`"moduleResolution": "bundler"`**

How tsc resolves `import "./lib/keybindings"` to a file on disk. `"bundler"` tells tsc to resolve like a bundler (esbuild, webpack, etc.) rather than like Node.js. Key differences:
- Allows extensionless imports (`import "./lib/keybindings"` finds `keybindings.ts`)
- Allows `import` of `.ts` files (Node resolution would require `.js` extension)
- Allows package.json `exports` field resolution

Without `"bundler"`, tsc would use `"node"` resolution which requires explicit `.js` extensions on relative imports — even though the source files are `.ts`. This is a common foot-gun. `"bundler"` mode matches how esbuild actually resolves imports.

**`"strict": true`**

Enables all strict type-checking flags at once. This is the most important setting for catching bugs. It turns on:
- `strictNullChecks` — `null` and `undefined` are distinct types. `let x: string = null` is an error. This catches null reference bugs at compile time instead of runtime.
- `strictFunctionTypes` — Function parameter types are checked contravariantly. Prevents passing a handler that expects `string` where one expecting `string | null` is needed.
- `strictPropertyInitialization` — Class properties must be initialized in the constructor. Catches "forgot to assign" bugs.
- `noImplicitAny` — Forces explicit typing when tsc can't infer. Prevents accidental `any` types from silently disabling type checking.
- `noImplicitThis` — Errors on `this` with implicit `any` type. Catches detached method bugs.
- `strictBindCallApply` — Type-checks `bind()`, `call()`, `apply()` arguments.
- `alwaysStrict` — Emits `"use strict"` in every file. (Irrelevant with `noEmit`.)
- `useUnknownInCatchVariables` — `catch (e)` gives `e` type `unknown` instead of `any`. Forces you to check the error type before accessing properties.

Every one of these has caught real bugs in this project. `strictNullChecks` alone caught dozens of cases where DOM queries could return `null`.

**`"noEmit": true`**

tsc never writes output files. It's purely a type checker. esbuild handles all code generation. This is the recommended setup when using esbuild — tsc checks types, esbuild compiles.

Why not just use tsc for everything? Because tsc is slow (entire-project type resolution) and doesn't bundle imports into single files. esbuild is fast and bundles. Splitting the responsibilities gives us fast builds + thorough type checking.

**`"skipLibCheck": true`**

Skips type-checking `.d.ts` files in `node_modules`. Without this, tsc would check every type definition file from every dependency, including `webextension-polyfill`'s types and transitive dependencies. This slows compilation significantly and occasionally produces false positives from third-party type definitions that have minor issues.

This is a tradeoff: we lose type-checking of library internals in exchange for faster `tsc` runs. Since we only import from well-tested libraries, this is the right tradeoff.

**`"esModuleInterop": true`**

Enables interop between CommonJS and ES module import styles. Without it, importing a CommonJS module would require:

```typescript
import * as browser from "webextension-polyfill";
```

With `esModuleInterop`, you can write:

```typescript
import browser from "webextension-polyfill";
```

This matches how esbuild handles the import at bundle time. Without this flag, tsc would error on the `import browser from` syntax for CommonJS packages.

**`"forceConsistentCasingInFileNames": true`**

Prevents importing `"./Keybindings"` when the file is `keybindings.ts`. macOS's filesystem is case-insensitive by default — the import would resolve correctly on Mac but fail on Linux (case-sensitive). This flag catches the mismatch at compile time.

Essential for projects that might be developed on Mac but deployed (or CI'd) on Linux.

**`"resolveJsonModule": true`**

Allows `import data from "./data.json"`. Not currently used in this project, but enabled as a convenience for potential future use (e.g., importing manifest data).

**`"isolatedModules": true`**

Requires every file to be independently compilable — no features that require cross-file type information. This is required for esbuild compatibility because esbuild compiles files individually (it doesn't do cross-file type analysis).

Things this disallows:
- `const enum` — requires cross-file inlining (regular `enum` is fine)
- `export =` / `import =` — CommonJS-specific syntax
- Re-exporting types without `export type`

If you write code that violates `isolatedModules`, tsc catches it immediately. Without this flag, you could write code that tsc compiles fine but esbuild silently miscompiles.

**`"rootDir": "src"`**

All source files live under `src/`. This affects the output directory structure — `src/lib/grep.ts` would output to `dist/lib/grep.js`. Since we set `noEmit: true`, this doesn't matter for output, but it tells tsc the expected source layout.

**`"outDir": "dist"`**

Where tsc would emit files if it emitted. With `noEmit: true`, this is purely informational — it tells tsc that `dist/` is the output location so it doesn't try to include compiled files as source.

**`"types": ["webextension-polyfill"]`**

Explicitly lists which `@types/*` packages to include in the compilation. Without this, tsc would auto-discover all `@types/*` packages in `node_modules`. By specifying only `webextension-polyfill`, we:
1. Get `browser.*` API types throughout the project
2. Exclude any other ambient type packages that might conflict or add unwanted globals

**`"include": ["src/**/*.ts"]`**

Only type-check `.ts` files under `src/`. Without this, tsc would check every `.ts` file it can find, including build scripts and config files.

**`"exclude": ["node_modules", "dist"]`**

Never look inside these directories for source files. `node_modules` is obvious. `dist` is excluded because it contains compiled output that shouldn't be re-processed.

---

## Build System — build.mjs

```javascript
import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, "dist");
const watching = process.argv.includes("--watch");

const targetIdx = process.argv.indexOf("--target");
const target = targetIdx !== -1 ? process.argv[targetIdx + 1] : "firefox";
if (!["firefox", "chrome"].includes(target)) {
  console.error(`[build] Unknown target "${target}".`);
  process.exit(1);
}

const manifestFile = target === "chrome" ? "manifest_v3.json" : "manifest_v2.json";

const shared = {
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: false,
  sourcemap: false,
};

const entryPoints = [
  { in: "src/background.ts", out: "background" },
  { in: "src/content-script.ts", out: "content-script" },
  { in: "src/popup/popup.ts", out: "popup/popup" },
  { in: "src/options/options.ts", out: "options/options" },
];

const staticFiles = [
  [`src/${manifestFile}`, "manifest.json"],
  ["src/popup/popup.html", "popup/popup.html"],
  ["src/popup/popup.css", "popup/popup.css"],
  ["src/options/options.html", "options/options.html"],
  ["src/options/options.css", "options/options.css"],
  ["src/icons/icon-48.png", "icons/icon-48.png"],
  ["src/icons/icon-96.png", "icons/icon-96.png"],
  ["src/icons/icon-128.png", "icons/icon-128.png"],
];

function copyStatic() {
  for (const [from, to] of staticFiles) {
    const dest = resolve(dist, to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(resolve(__dirname, from), dest);
  }
}

async function main() {
  mkdirSync(dist, { recursive: true });
  copyStatic();
  const buildOptions = { ...shared, entryPoints: ..., outdir: dist };
  if (watching) {
    const ctx = await context(buildOptions);
    await ctx.watch();
  } else {
    await build(buildOptions);
  }
}
```

### Line-by-line

**`import { build, context } from "esbuild"`** — Two esbuild APIs:
- `build()` — One-shot compilation. Reads source, writes output, exits.
- `context()` — Creates a long-running build context for watch mode. Calls `ctx.watch()` to start monitoring files.

**`const __dirname = dirname(fileURLToPath(import.meta.url))`** — ES modules don't have `__dirname` (that's a CommonJS global). This reconstructs it from `import.meta.url`, which gives the file's URL (e.g., `file:///path/to/build.mjs`). `fileURLToPath` converts it to a path, `dirname` extracts the directory.

**`const watching = process.argv.includes("--watch")`** — Simple flag parsing. `process.argv` contains `["node", "build.mjs", "--watch", "--target", "firefox"]`. `includes("--watch")` checks if the flag is present.

**Target parsing** — `process.argv.indexOf("--target")` finds the flag position, then reads the next argument as the value. Defaults to `"firefox"` if not specified. Validates against a whitelist. This is why `npm run build:chrome` works — the npm script passes `--target chrome`.

**`const manifestFile`** — Selects which manifest to copy based on target. Chrome gets MV3, Firefox gets MV2. The build output is always `manifest.json` — the browser doesn't know about our dual-manifest setup.

### esbuild shared options

**`bundle: true`** — Resolves all `import` statements and inlines dependencies into the output files. Without this, the output would still have `import` statements, which browsers can't execute in extension contexts (there's no module loader).

**`format: "iife"`** — Wraps output in an Immediately Invoked Function Expression: `(() => { ...code... })()`. This prevents variable leakage into the global scope. Without it, `let harpoonList = []` in `background.ts` would become a global variable. IIFE ensures each script has its own scope.

Why IIFE and not ESM? Browser extension scripts (content scripts, background scripts) run in the global scope by default. MV3 service workers could use ESM, but MV2 background pages cannot. IIFE works universally.

**`target: "es2022"`** — Tells esbuild what JavaScript features it can assume the runtime supports. ES2022 means: keep `??`, `?.`, class fields, `Promise.allSettled()`, etc. as-is. Don't transpile them to older syntax. Must match `tsconfig.json`'s target.

**`minify: false`** — Don't minify output. Keeps the code readable for:
1. **Debugging** — You can read the compiled JS in browser devtools.
2. **Store review** — Firefox AMO reviewers read your code. Minified code triggers extra scrutiny and can delay review.

Set to `true` for production if you want smaller files (saves ~30-40% size).

**`sourcemap: false`** — Don't generate source maps. Source maps link compiled JS back to TypeScript source for debugging. Disabled here because:
1. Extension content scripts load source maps relative to the page's origin, which fails
2. The unminified output is readable enough without maps
3. Reduces build output size

### Entry points

Four separate builds, four output files:
- `background.ts` → `dist/background.js` — Background script/service worker
- `content-script.ts` → `dist/content-script.js` — Injected into every page
- `popup/popup.ts` → `dist/popup/popup.js` — Popup page script
- `options/options.ts` → `dist/options/options.js` — Options page script

Each entry point gets its own IIFE bundle. `webextension-polyfill` is bundled into each one independently. This means it's duplicated across files, but each file is self-contained — no shared runtime dependency.

### Static file copying

HTML, CSS, icons, and the manifest are not processed by esbuild — they're copied verbatim using Node's `cpSync`. `mkdirSync` with `{ recursive: true }` creates parent directories (e.g., `dist/popup/`) if they don't exist.

### Watch mode

`context()` creates a persistent build context. `ctx.watch()` starts a file system watcher that recompiles on any source change. This is faster than running `build()` repeatedly because the context keeps esbuild's internal state warm.

Note: watch mode only watches TypeScript files (esbuild's entry points and their imports). Static files (HTML, CSS, icons) are only copied once at startup. If you change `popup.html` while watching, you need to restart the build.

---

## Manifests — MV2 and MV3

Browser extensions require a `manifest.json` that declares permissions, scripts, icons, and commands. Firefox and Chrome use different manifest versions with different schemas.

### manifest_v2.json (Firefox/Zen)

```json
{
  "manifest_version": 2,
  "name": "Harpoon Telescope",
  "version": "2.0.0",
  "description": "...",
  "permissions": ["tabs", "activeTab", "storage", "<all_urls>"],
  "background": { "scripts": ["background.js"], "persistent": false },
  "content_scripts": [{ "matches": ["<all_urls>"], "js": ["content-script.js"], "run_at": "document_idle" }],
  "commands": { ... },
  "options_ui": { "page": "options/options.html", "open_in_tab": true },
  "browser_action": { "default_icon": { "48": "icons/icon-48.png", "96": "icons/icon-96.png" }, "default_popup": "popup/popup.html" },
  "icons": { "48": "icons/icon-48.png", "96": "icons/icon-96.png", "128": "icons/icon-128.png" }
}
```

### Key manifest fields

**`"permissions"`** — What browser APIs the extension can use:
- `"tabs"` — Access `browser.tabs.query()`, `browser.tabs.update()`, `browser.tabs.create()`, `browser.tabs.get()`, tab events (`onActivated`, `onUpdated`, `onRemoved`). Required for all harpoon and frecency functionality.
- `"activeTab"` — Permission to access the currently active tab when the user invokes the extension. More restrictive than `<all_urls>` but we need both.
- `"storage"` — Access `browser.storage.local` for persisting harpoon list, sessions, frecency data, and keybindings.
- `"<all_urls>"` — Permission to inject content scripts and send messages to tabs on any URL. Required because our content script runs on every page. This triggers a "can read and change all your data" warning to users.

**`"background": { "scripts": ["background.js"], "persistent": false }`** — In MV2, the background page runs `background.js`. `persistent: false` makes it an "event page" — the browser can unload it when idle. This saves memory but means in-memory state can be lost (hence `ensureHarpoonLoaded()`).

**`"content_scripts"`** — Declares scripts to inject into web pages:
- `"matches": ["<all_urls>"]` — Inject on every page.
- `"run_at": "document_idle"` — Inject after the DOM is complete and the page is mostly loaded. Alternatives: `"document_start"` (before DOM), `"document_end"` (DOM complete but resources still loading). We use `idle` to avoid slowing down page load.

**`"commands"`** — Keyboard shortcuts registered with the browser. Firefox allows 8+ commands, Chrome MV3 limits to 4.

Each command has `"suggested_key"` — the default shortcut. Users can rebind these in the browser's extension shortcut settings (`about:addons` → gear icon → Manage Extension Shortcuts in Firefox, `chrome://extensions/shortcuts` in Chrome).

**`"browser_action"` (MV2) vs `"action"` (MV3)** — The toolbar button. `default_icon` shows the icon, `default_popup` opens the popup HTML when clicked.

**`"options_ui": { "open_in_tab": true }`** — The settings page opens as a full tab, not a popup. This gives enough space for the keybinding editor grid.

### manifest_v3.json (Chrome) — Key differences

```json
{
  "manifest_version": 3,
  "permissions": ["tabs", "activeTab", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "action": { ... },
  "commands": { /* only 4 */ }
}
```

- **`"host_permissions"`** — MV3 splits URL-based permissions out of `"permissions"` into `"host_permissions"`. Same effect, different key.
- **`"service_worker"`** — MV3 replaces the background page with a service worker. Service workers can be terminated at any time by the browser. This is why `ensureHarpoonLoaded()` exists — every function must be able to reload state from scratch.
- **`"action"`** — MV3 renames `browser_action` to `action`. Same fields.
- **Commands limit** — Chrome MV3 allows only 4 commands total. We register the most critical: `open-harpoon`, `harpoon-add`, `open-telescope-current`. Everything else (slot jumps 1-4, cycling, frecency, bookmarks, history, vim toggle) is handled by the content script's `keydown` listener.

---

## Type Declarations — types.d.ts

```typescript
interface HarpoonEntry {
  tabId: number;
  url: string;
  title: string;
  scrollX: number;
  scrollY: number;
  slot: number;
  closed?: boolean;
}
```

This is an **ambient declaration file** (`.d.ts`). Interfaces declared here are globally available to all `.ts` files without importing. This is intentional — these types are used across all contexts (background, content, popup, options).

### Why `.d.ts` instead of a regular `.ts` file?

A `.d.ts` file contains only type declarations, no runtime code. TypeScript treats it as ambient — the interfaces are available everywhere without `import`. A regular `.ts` file would require `export` and `import` statements.

For shared interfaces used across 10+ files, ambient declarations reduce boilerplate. The tradeoff: you can't have naming collisions with other ambient types.

### Key interfaces

**`HarpoonEntry`** — One pinned tab. `closed?: boolean` tracks tabs that the user closed but the harpoon entry preserves. When you jump to a closed entry, it re-opens the URL in a new tab. This is critical for browser restarts where all previous tab IDs become invalid.

**`KeybindingsConfig`** — The full keybinding state. `navigationMode` is `"basic"` or `"vim"`. `bindings` is nested by scope (`global`, `harpoon`, `search`), then by action name, then contains `key` (current) and `default` (original). Storing both enables per-binding reset.

**`SearchFilter`** — A string literal union type: `"code" | "headings" | "links" | "images"`. Using a union type instead of a plain string means TypeScript catches typos at compile time — `"cod"` would be a type error.

**`GrepResult`** — A single search result. Notable fields:
- `nodeRef?: WeakRef<Node>` — A weak reference to the DOM node. See [State Management](#state-management) for why `WeakRef` matters here.
- `domContext?: string[]` — Context lines extracted from the same DOM parent (not just adjacent array items). This gives better preview context for code blocks.
- `ancestorHeading?: string` — The nearest `<h1>`-`<h6>` above this result in the DOM tree. Used in the preview breadcrumb.
- `href?: string` — For `<a>` tags, the link's destination URL. Shown in the preview breadcrumb.

**`FrecencyEntry`** — A tab visit record. `frecencyScore` is precomputed and stored (not computed on read) because it's used for both sorting and eviction decisions.

**`HarpoonSession`** — A saved snapshot of the harpoon list. Stores `HarpoonSessionEntry[]` (URLs, titles, scroll positions) but NOT `tabId` — tab IDs are meaningless after browser restart.

---

## Architecture — How Extension Contexts Work

A browser extension has multiple execution contexts that run in separate OS processes:

```
┌─────────────────────┐
│   Background Script  │  ← browser.tabs, browser.storage, browser.commands
│   (background.ts)    │     One instance for the entire extension
│                     │     MV2: event page | MV3: service worker
└────────┬────────────┘
         │  browser.runtime.sendMessage (content → background)
         │  browser.tabs.sendMessage    (background → content)
         │
┌────────┴────────────┐  ┌───────────────────┐  ┌───────────────────┐
│  Content Script      │  │  Content Script    │  │  Content Script    │
│  (Tab 1)             │  │  (Tab 2)           │  │  (Tab 3)           │
│  content-script.ts   │  │  content-script.ts  │  │  content-script.ts  │
│  + overlay panels    │  │  + overlay panels   │  │  + overlay panels   │
└──────────────────────┘  └───────────────────┘  └───────────────────┘
                                                         │
                                                  ┌──────┴──────────┐
                                                  │  Popup / Options │
                                                  │  (own HTML page) │
                                                  └─────────────────┘
```

### Why message passing?

Each context runs in a separate process (for security isolation). You cannot:
- Call functions in another context
- Share variables
- Pass DOM nodes, functions, or circular references

All communication is JSON serialization over IPC. `browser.runtime.sendMessage()` sends from content/popup/options to background. `browser.tabs.sendMessage()` sends from background to a specific tab's content script.

Messages are plain objects with a `type` field that acts as a discriminator:

```typescript
{ type: "HARPOON_ADD" }
{ type: "HARPOON_JUMP", slot: 3 }
{ type: "GREP", query: "api", filters: ["code"] }
```

Both sides use a `switch` on `m.type` to route to handlers. This is the simplest pattern that scales to dozens of message types.

### Content script constraints

Content scripts have access to the page's DOM but limited browser API access:
- **Can**: `browser.runtime.sendMessage()`, `browser.storage.onChanged`, `document.*`
- **Cannot**: `browser.tabs.*`, `browser.commands.*` (background-only APIs)

This is why the content script sends messages to the background for tab operations (add, jump, remove, cycle) — it can't manipulate tabs directly.

---

## Content Script — content-script.ts

The content script is the entry point for every web page. It does three things:

1. **Routes messages** from the background to the right handler
2. **Handles keybindings** that can't go through `browser.commands` (Chrome's 4-command limit)
3. **Manages the lifecycle** of overlay panels

### Injection cleanup

```typescript
declare global {
  interface Window {
    __harpoonTelescopeCleanup?: () => void;
  }
}

(() => {
  if (window.__harpoonTelescopeCleanup) {
    window.__harpoonTelescopeCleanup();
  }
  // ... setup ...
  window.__harpoonTelescopeCleanup = () => {
    document.removeEventListener("keydown", globalKeyHandler);
    document.removeEventListener("visibilitychange", visibilityHandler);
    browser.runtime.onMessage.removeListener(messageHandler);
    const host = document.getElementById("ht-panel-host");
    if (host) host.remove();
  };
})();
```

**Problem**: Firefox caches content scripts aggressively. When you reload the extension during development, the old content script stays alive in memory alongside the new one. Both respond to messages.

**Wrong fix**: `if (window.__harpoonTelescopeInjected) return;` — This prevents the NEW code from loading after a reload. The old (possibly buggy) code keeps running.

**Right fix**: Store a cleanup function. New injection calls the old cleanup first, then sets up fresh listeners. The old event handlers are removed, old panels are destroyed, and the new code takes over.

The `declare global` block extends the `Window` interface to include our cleanup function. Without this, TypeScript would error on `window.__harpoonTelescopeCleanup` since it's not part of the standard `Window` type.

The entire script is wrapped in an IIFE `(() => { ... })()` to avoid polluting the global scope. esbuild also wraps in IIFE (via `format: "iife"`), so this is double-wrapped — harmless but explicit about intent.

### Config caching

```typescript
let cachedConfig: KeybindingsConfig | null = null;

async function getConfig(): Promise<KeybindingsConfig> {
  if (!cachedConfig) {
    cachedConfig = (await browser.runtime.sendMessage({
      type: "GET_KEYBINDINGS",
    })) as KeybindingsConfig;
  }
  return cachedConfig;
}

browser.storage.onChanged.addListener((changes) => {
  if (changes.keybindings) cachedConfig = null;
});
```

Every keypress calls `getConfig()`. Without caching, that's a message round-trip to the background (async IPC) on every keypress — noticeable latency. The cache loads once and stays in memory.

`storage.onChanged` fires in ALL contexts when ANY context writes to storage. When the options page saves new keybindings, this listener fires in every open tab's content script, invalidating their caches. Next keypress fetches the fresh config.

This is a **read-through cache with event-driven invalidation** — a pattern that works anywhere you have a shared data store with change notifications.

### Global key handler

```typescript
async function globalKeyHandler(e: KeyboardEvent): Promise<void> {
  const config = await getConfig();

  // toggleVim must work regardless of whether a panel is open
  if (matchesAction(e, config, "global", "toggleVim")) { ... }

  // Skip if a panel is open (panel has its own handler)
  if (document.getElementById("ht-panel-host")) return;

  if (matchesAction(e, config, "global", "openHarpoon")) { ... }
  else if (matchesAction(e, config, "global", "searchInPage")) { ... }
  // ... etc
}

document.addEventListener("keydown", globalKeyHandler);
```

This handler runs on every keypress on every page. It's intentionally lightweight — the `getConfig()` call usually hits the cache (synchronous return), and the `matchesAction` checks are simple string comparisons.

**The `toggleVim` check comes first and doesn't skip when a panel is open.** This is because `Alt+V` must work everywhere — with or without a panel. The panel's own key handler also intercepts `Alt+V` (in capturing phase, before `stopPropagation` kills the event), but this handler serves as the fallback when no panel is open.

**Panel guard**: `if (document.getElementById("ht-panel-host")) return;` — When a panel is open, its own key handler (registered with `capture: true`) handles all keys. The global handler bails to avoid double-handling. The `getElementById` check is a DOM query on every keypress, but it's fast (direct ID lookup, O(1) in modern browsers).

### Message router

```typescript
function messageHandler(msg: unknown): Promise<unknown> | undefined {
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "GET_SCROLL":
      return Promise.resolve({ scrollX: window.scrollX, scrollY: window.scrollY });
    case "SET_SCROLL":
      window.scrollTo(m.scrollX as number, m.scrollY as number);
      return Promise.resolve({ ok: true });
    case "GREP":
      return Promise.resolve(grepPage(m.query as string, (m.filters as SearchFilter[]) || []));
    // ... more cases
  }
}
```

**Return type `Promise<unknown> | undefined`** — The browser's message passing expects handlers to return a Promise (or undefined to indicate "not handled"). Returning `undefined` lets other listeners handle the message. Returning a Promise sends the resolved value as the response.

**`msg: unknown`** — The message could be anything. We cast to `Record<string, unknown>` and check `m.type`. This is safe because all our messages follow the `{ type: string, ...data }` convention.

**Synchronous operations wrapped in `Promise.resolve()`** — `GET_SCROLL` just reads `window.scrollX` (synchronous), but the handler must return a Promise. `Promise.resolve()` wraps the value without adding a microtask — it resolves immediately.

### Visibility change auto-close

```typescript
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    const host = document.getElementById("ht-panel-host");
    if (host) host.remove();
  }
});
```

When the user switches tabs or minimizes the browser, `visibilitychange` fires. We close any open panel to prevent stale overlays. Without this, switching to Tab 2 and back to Tab 1 would show the old panel still open with potentially outdated data.

---

## Background Script — background.ts

The background script is the "server" of the extension. It manages all persistent state, coordinates actions between tabs, and routes messages.

### State management pattern

```typescript
let harpoonList: HarpoonEntry[] = [];
let harpoonLoaded = false;

async function ensureHarpoonLoaded(): Promise<void> {
  if (!harpoonLoaded) {
    const data = await browser.storage.local.get("harpoonList");
    harpoonList = (data.harpoonList as HarpoonEntry[]) || [];
    harpoonLoaded = true;
  }
}

async function saveHarpoon(): Promise<void> {
  await browser.storage.local.set({ harpoonList });
}
```

This is a **lazy-load guard**. The pattern:
1. Module-level variable starts empty
2. Every function that touches the variable calls `ensureLoaded()` first
3. `ensureLoaded()` is idempotent — safe to call 100 times, only loads once
4. On MV3 (Chrome), the service worker can be killed. When it restarts, `harpoonLoaded` resets to `false`, triggering a fresh load

**Why not load eagerly on startup?** We do call `ensureHarpoonLoaded()` at the bottom of the file (eager start), but the guard is still needed because in MV3, the service worker can restart between any two calls. The eager load is an optimization, not a guarantee.

### Reconciliation

```typescript
async function reconcileHarpoon(): Promise<void> {
  await ensureHarpoonLoaded();
  const tabs = await browser.tabs.query({});
  const tabIds = new Set(tabs.map((t) => t.id));
  for (const entry of harpoonList) {
    entry.closed = !tabIds.has(entry.tabId);
  }
  recompactSlots();
  await saveHarpoon();
}
```

Tab IDs are ephemeral — they're reassigned by the browser and don't persist across restarts. `reconcileHarpoon()` queries all currently open tabs and marks harpoon entries as `closed` if their tab no longer exists.

This is called before every `HARPOON_LIST` response and before `harpoonAdd()`. It's the source of truth for which entries are live vs closed.

**`recompactSlots()`** — Re-numbers slots sequentially (1, 2, 3...) after any list mutation. Without this, deleting slot 2 from [1, 2, 3] would leave [1, 3] instead of [1, 2].

### Harpoon jump with closed tab re-opening

```typescript
async function harpoonJump(slot: number): Promise<void> {
  const entry = harpoonList.find((e) => e.slot === slot);
  if (!entry) return;

  if (entry.closed) {
    await saveCurrentTabScroll();
    const newTab = await browser.tabs.create({ url: entry.url, active: true });
    entry.tabId = newTab.id!;
    entry.closed = false;
    await saveHarpoon();

    const onUpdated = (tabId, info) => {
      if (tabId === newTab.id && info.status === "complete") {
        browser.tabs.onUpdated.removeListener(onUpdated);
        browser.tabs.sendMessage(newTab.id!, {
          type: "SET_SCROLL", scrollX: entry.scrollX, scrollY: entry.scrollY,
        }).catch(() => {});
      }
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => browser.tabs.onUpdated.removeListener(onUpdated), 10000);
    return;
  }
  // Tab is open — switch to it
  // ...
}
```

When jumping to a closed entry:
1. Save current tab's scroll position (so you can come back)
2. Create a new tab with the saved URL
3. Update the entry's `tabId` to the new tab's ID
4. Wait for the tab to finish loading (`status === "complete"`)
5. Restore scroll position

The `onUpdated` listener is a one-shot callback — it removes itself after firing. The `setTimeout(..., 10000)` is a safety net: if the tab never completes loading (e.g., network error), remove the listener after 10 seconds to prevent memory leaks.

### Tab lifecycle listeners

```typescript
browser.tabs.onRemoved.addListener(async (tabId) => {
  const entry = harpoonList.find((e) => e.tabId === tabId);
  if (entry) {
    entry.closed = true;
    await saveHarpoon();
  }
  await removeFrecencyEntry(tabId);
});
```

When a tab closes, mark its harpoon entry as `closed` (don't delete it — the user can re-open it). Also remove it from frecency tracking.

```typescript
browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const entry = harpoonList.find((e) => e.tabId === tabId);
  if (entry) {
    if (changeInfo.url) entry.url = changeInfo.url;
    if (changeInfo.title) entry.title = changeInfo.title;
    if (changed) {
      if (onUpdatedSaveTimer) clearTimeout(onUpdatedSaveTimer);
      onUpdatedSaveTimer = setTimeout(() => saveHarpoon(), 500);
    }
  }
});
```

When a tab's URL or title changes (e.g., SPA navigation), update the harpoon entry. The save is **debounced** — SPAs can fire dozens of URL/title changes per navigation. Without the 500ms debounce, we'd hammer `browser.storage.local.set()`.

```typescript
browser.tabs.onActivated.addListener(async (activeInfo) => {
  const prevTabId = lastActiveTabId;
  lastActiveTabId = activeInfo.tabId;
  await recordFrecencyVisit(tab);
  // Save scroll for previously active harpooned tab
  // ...
});
```

**`lastActiveTabId`** — Tracks the previously active tab. On activation, we save the previous tab's scroll position (if it's in harpoon) and record a frecency visit for the newly active tab.

### Session restore on startup

```typescript
browser.runtime.onStartup.addListener(async () => {
  const sessions = ...;
  if (sessions.length === 0) return;

  harpoonList = [];
  await saveHarpoon();

  let attempts = 0;
  const tryPrompt = async () => {
    attempts++;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    try {
      await browser.tabs.sendMessage(tab.id, { type: "SHOW_SESSION_RESTORE" });
    } catch (_) {
      if (attempts < 5) setTimeout(tryPrompt, 1000);
    }
  };
  setTimeout(tryPrompt, 1500);
});
```

On browser startup, all previous tab IDs are invalid. The harpoon list is cleared. If saved sessions exist, we show a restore prompt.

The retry logic (5 attempts, 1s apart) handles the race condition where tabs are loading and content scripts aren't ready yet. The initial 1.5s delay gives the browser time to load at least one tab.

---

## Keybinding System — keybindings.ts

This module defines the keybinding schema, provides key matching utilities, and handles collision detection.

### Default bindings

```typescript
export const DEFAULT_KEYBINDINGS: KeybindingsConfig = {
  navigationMode: "basic",
  bindings: {
    global: {
      openHarpoon: { key: "Alt+T", default: "Alt+T" },
      // ...14 actions
    },
    harpoon: {
      moveUp: { key: "ArrowUp", default: "ArrowUp" },
      // ...8 actions
    },
    search: {
      moveUp: { key: "ArrowUp", default: "ArrowUp" },
      // ...7 actions
    },
  },
};
```

Every binding stores both `key` (current) and `default` (original). This enables per-binding reset in the options page. When the user clicks "reset" on a single binding, we set `key = default` without affecting other bindings.

Bindings are **scoped**: `global` shortcuts work on any page, `harpoon` shortcuts only work inside the harpoon panel, `search` shortcuts only inside telescope/frecency. This means `"D"` in the harpoon scope (delete entry) doesn't conflict with `"D"` in the search scope (not used) or with `"ArrowDown"` in any scope.

### Forward-compatible merging

```typescript
function mergeWithDefaults(stored: Partial<KeybindingsConfig>): KeybindingsConfig {
  const merged = JSON.parse(JSON.stringify(DEFAULT_KEYBINDINGS));
  merged.navigationMode = stored.navigationMode || "basic";
  for (const scope of Object.keys(merged.bindings)) {
    for (const action of Object.keys(merged.bindings[scope])) {
      const storedBinding = stored.bindings?.[scope]?.[action];
      if (storedBinding) merged.bindings[scope][action].key = storedBinding.key;
    }
  }
  return merged;
}
```

When the extension updates and adds new actions (e.g., `openFrecency`), users who saved keybindings before the update won't have the new action in their stored config. `mergeWithDefaults` starts from the full default config and overlays the user's stored values on top. New actions get their defaults; existing customizations are preserved.

`JSON.parse(JSON.stringify(...))` is a deep clone. Without it, modifications to `merged` would mutate `DEFAULT_KEYBINDINGS`.

### Key matching

```typescript
export function matchesKey(e: KeyboardEvent, keyString: string): boolean {
  const parts = keyString.split("+");
  const key = parts[parts.length - 1];
  if (e.ctrlKey !== parts.includes("Ctrl")) return false;
  if (e.altKey !== parts.includes("Alt")) return false;
  // ...
  let eventKey = e.key;
  if (eventKey.length === 1) eventKey = eventKey.toUpperCase();
  return eventKey === key;
}
```

Converts `"Alt+T"` to `{ modifiers: ["Alt"], key: "T" }` and compares against a KeyboardEvent. Single-character keys are uppercased for case-insensitive matching — this is why the caps lock key doesn't break vim mode.

**`matchesAction()`** wraps `matchesKey()` to check all keys for an action (primary key + vim aliases):

```typescript
export function matchesAction(e, config, scope, action): boolean {
  const keys = getKeysForAction(config, scope, action);
  return keys.some((k) => matchesKey(e, k));
}
```

### Vim aliases — additive, not replacement

```typescript
const VIM_ENHANCED_ALIASES: Record<string, Record<string, string[]>> = {
  harpoon: { moveUp: ["K"], moveDown: ["J"] },
  search: {
    moveUp: ["K"], moveDown: ["J"],
  },
};
```

When `config.navigationMode === "vim"`, `getKeysForAction()` returns `["ArrowDown", "J"]` for `moveDown`. Arrow keys always work. `j`/`k` are bonuses. Users don't need to learn vim to use the extension.

### Collision detection

```typescript
export function checkCollision(config, scope, action, key): CollisionResult | null {
  for (const [act, binding] of Object.entries(scopeBindings)) {
    if (act === action) continue;
    if (binding.key === key) return { action: act, label };
  }
  return null;
}
```

Per-scope only. `Alt+T` in `global` doesn't collide with `T` in `harpoon` because they're never active simultaneously. The options page calls this before accepting a new key binding.

---

## Panel Host — panel-host.ts

Creates the Shadow DOM container for all overlay panels. Every panel (harpoon, telescope, frecency, session restore) uses this.

### Shadow DOM creation

```typescript
export function createPanelHost(): PanelHost {
  const existing = document.getElementById("ht-panel-host");
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = "ht-panel-host";
  host.tabIndex = -1;
  host.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  document.body.appendChild(host);
  // ...
}
```

**`existing.remove()`** — Only one panel at a time. Opening harpoon while telescope is open replaces it.

**`host.tabIndex = -1`** — Makes the host focusable programmatically (`host.focus()`) but not via Tab key. This is needed for focus trapping — when focus escapes the panel, we reclaim it.

**`z-index: 2147483647`** — The maximum 32-bit integer. This ensures our overlay appears above everything on the page, including other extensions, modal dialogs, and sticky headers.

**`attachShadow({ mode: "open" })`** — Creates an open Shadow DOM. "Open" means `host.shadowRoot` is accessible from JavaScript. We could use "closed" for stronger encapsulation, but we need `shadowRoot` access for focus management and vim badge updates.

### Focus trapping

```typescript
host.addEventListener("focusout", (e: FocusEvent) => {
  const related = e.relatedTarget as Node | null;
  const staysInPanel =
    related && (host.contains(related) || host.shadowRoot!.contains(related));
  if (!staysInPanel) {
    setTimeout(() => {
      if (document.getElementById("ht-panel-host")) host.focus();
    }, 0);
  }
});
```

Shadow DOM children are NOT found by `host.contains()`. You must check both `host.contains()` (for the host element itself) and `host.shadowRoot.contains()` (for elements inside the shadow tree).

The `setTimeout(..., 0)` defers the focus reclaim to after the current event completes. Without it, calling `host.focus()` during `focusout` can create a focus loop in some browsers.

The `document.getElementById` check inside the timeout prevents focusing a panel that was closed between the timeout being scheduled and executing.

### Base styles

```typescript
export function getBaseStyles(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :host { all: initial; font-family: 'SF Mono', ...; }
    .ht-backdrop { ... backdrop-filter: blur(1px); will-change: backdrop-filter; }
    .ht-titlebar { ... }
    // ...
  `;
}
```

**`:host { all: initial; }`** — Resets ALL inherited CSS properties on the shadow host. Without this, the page's `font-size: 32px` or `color: red` would leak into the shadow tree via CSS inheritance.

**`will-change: backdrop-filter`** — Tells the browser to promote this element to its own GPU compositing layer. The `backdrop-filter: blur(1px)` effect is computationally expensive; doing it on the GPU prevents CPU-based compositing jank.

Styles are returned as a string and injected via a `<style>` element inside each panel's Shadow DOM. Each panel appends its own component-specific styles after the base styles.

---

## Helpers — helpers.ts

Three utility functions used across content script modules.

### escapeHtml — XSS prevention

```typescript
const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}
```

Every time user-supplied text (page content, titles, URLs) is inserted via `innerHTML`, it must be escaped. Without this, a page title like `<script>alert('xss')</script>` would execute.

This uses a static lookup table and a single regex pass. The alternative — creating a DOM element with `textContent` and reading `innerHTML` — allocates a DOM node per call. For a function called hundreds of times per search keystroke, the string approach is measurably faster.

### escapeRegex — safe user input in RegExp

```typescript
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

When creating a RegExp from user input (for highlight matching), special characters must be escaped. Without this, a search query like `foo.bar(` would throw `SyntaxError: Invalid regular expression`.

### extractDomain — URL to hostname

```typescript
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return url.length > 30 ? url.substring(0, 30) + "…" : url;
  }
}
```

The `try/catch` handles malformed URLs (e.g., `about:blank`, data URIs). The fallback truncates long strings with an ellipsis.

---

## Feedback — feedback.ts

A single-function module for center-screen toast notifications.

```typescript
export function showFeedback(message: string): void {
  const existing = document.getElementById("ht-feedback-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ht-feedback-toast";
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed", top: "50%", left: "50%",
    transform: "translate(-50%, -50%)",
    zIndex: "2147483647",
    // ...styling
  });
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 1500);
}
```

**Not inside Shadow DOM** — The toast is appended directly to `document.body`, not inside a panel's shadow. This is because it needs to appear even when no panel is open (e.g., "Added to Harpoon [3]" after `Alt+A`).

**`existing.remove()`** — Prevents stacking toasts. Each new message replaces the previous one.

**Two-phase removal**: fade out over 300ms (`opacity: 0` with CSS transition), then remove from DOM. This prevents the abrupt disappearance of instant removal.

---

## Fuzzy Search Engine — grep.ts

The most complex module. 574 lines implementing: DOM text collection, caching with MutationObserver, structural filters, character-by-character fuzzy scoring, and context extraction.

### Fuzzy scoring algorithm

```typescript
function scoreTerm(term: string, candidate: string): number | null {
  let score = 0;
  let termIdx = 0;
  let prevMatchIdx = -2;

  for (let i = 0; i < candLen && termIdx < termLen; i++) {
    if (candidate[i] === term[termIdx]) {
      score += SCORE_BASE;                    // 1 point per match
      if (i === prevMatchIdx + 1)
        score += SCORE_CONSECUTIVE;           // 8 points for adjacent
      if (i === 0) score += SCORE_START;      // 6 points at position 0
      else if (WORD_SEPARATORS.has(candidate[i-1]))
        score += SCORE_WORD_BOUNDARY;         // 10 points after separator
      if (prevMatchIdx >= 0)
        score += (i - prevMatchIdx - 1) * PENALTY_DISTANCE;  // -1 per gap
      prevMatchIdx = i;
      termIdx++;
    }
  }
  if (termIdx < termLen) return null;  // not all chars matched
  return score;
}
```

This is a single-pass O(n) algorithm. For each character in the candidate string, it checks if it matches the next required character from the search term. Key scoring factors:

- **Consecutive bonus (8)** — Rewards exact substrings. "hand" in "handleData" scores higher than "h...a...n...d" scattered across the string.
- **Word boundary bonus (10)** — Highest bonus. Rewards matching after separators (space, dash, dot, etc.). "hdr" matching at the start of "handle-data-request" gets boundary bonuses on "d" (after "-") and "r" (after "-").
- **Start bonus (6)** — Match at the beginning of the string is likely more relevant.
- **Distance penalty (-1 per gap)** — Punishes gaps between matched characters. "hr" with 10 characters between h and r loses 10 points.

These constants were tuned empirically. The consecutive bonus being high (8x base) ensures that exact substring matches dominate over scattered character matches.

### Multi-word queries

```typescript
function fuzzyMatch(query: string, candidate: string): number | null {
  const terms = query.split(" ");
  let totalScore = 0;
  for (const term of terms) {
    const s = scoreTerm(term, candidate);
    if (s === null) return null;  // ALL terms must match
    totalScore += s;
  }
  return totalScore;
}
```

AND semantics — every space-separated term must match. "api endpoint" requires both "api" AND "endpoint" in the candidate. Scores are summed.

### Pre-lowercasing

```typescript
interface TaggedLine {
  text: string;    // original for display
  lower: string;   // pre-lowercased for matching
  tag: string;
  nodeRef?: WeakRef<Node>;
}
```

Lowercasing is done once at collection time. The query is lowercased once at search time. This avoids calling `.toLowerCase()` on every candidate for every keystroke — with 5000 lines and 10 keystrokes, that's 50,000 avoided string allocations.

### Line cache with MutationObserver

```typescript
const cache: LineCache = {
  all: TaggedLine[] | null,
  code: TaggedLine[] | null,
  headings: TaggedLine[] | null,
  links: TaggedLine[] | null,
  observer: MutationObserver | null,
  invalidateTimer: ReturnType<typeof setTimeout> | null,
};
```

The DOM is walked once per telescope session. Subsequent keystrokes filter the cached array. The MutationObserver watches for DOM changes (dynamic pages, SPAs) and invalidates the cache with a 500ms debounce.

**`initLineCache()`** — Called when telescope opens. Starts the observer.
**`destroyLineCache()`** — Called when telescope closes. Stops the observer and frees the cache.

### Structural filters — union semantics

```typescript
function collectLines(filters: SearchFilter[]): TaggedLine[] {
  if (filters.length === 0) return collectAll();
  if (filters.length === 1) {
    switch (filters[0]) {
      case "code": return collectCode();
      case "headings": return collectHeadings();
      case "links": return collectLinks();
      case "images": return collectImages();
    }
  }
  // Multiple filters — union
  const lines: TaggedLine[] = [];
  for (const filter of filters) {
    switch (filter) {
      case "code": lines.push(...collectCode()); break;
      case "images": lines.push(...collectImages()); break;
      // ...
    }
  }
  return lines;
}
```

`/code /links` returns all code lines AND all link lines (union). The fuzzy query then narrows within that pool. Each sub-collection is independently cached. `/img` collects `<img>` elements using their `alt` text, `title`, or filename from `src` as the searchable text.

### Code collection — `<pre>` splitting

```typescript
function collectCode(): TaggedLine[] {
  const codeEls = document.querySelectorAll("pre, code");
  for (const codeEl of codeEls) {
    if (el.tagName === "CODE" && el.parentElement?.tagName === "PRE") continue; // skip nested
    if (el.tagName === "PRE") {
      const splitLines = el.textContent.split("\n");
      for (const line of splitLines) {
        lines.push({ text: trimmed, tag: "PRE", ... });
      }
    } else {
      lines.push({ text, tag: "CODE", ... });
    }
  }
}
```

`<pre>` blocks are split into individual lines so each line is a searchable result. `<code>` inside `<pre>` is skipped (the `<pre>` already covers it). Standalone `<code>` is collected as a single result tagged `[CODE]`.

### All-text collection — TreeWalker

```typescript
function collectAll(): TaggedLine[] {
  // First: collect <pre> blocks split by line
  const preSet = new Set<Node>();
  for (const pre of document.querySelectorAll("pre")) { ... preSet.add(pre); }

  // Then: walk all text nodes, skipping those inside <pre>
  const walker = document.createTreeWalker(
    document.body, NodeFilter.SHOW_TEXT,
    { acceptNode(node) {
        if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
        // Walk up to check if inside a <pre>
        let ancestor = el;
        while (ancestor) {
          if (preSet.has(ancestor)) return NodeFilter.FILTER_REJECT;
          ancestor = ancestor.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
}
```

`TreeWalker` is the most efficient way to iterate text nodes. It's faster than `querySelectorAll("*")` + checking `textContent` because it only visits text nodes (not elements) and allows filtering via `acceptNode`.

The `preSet` check prevents double-counting: `<pre>` content is already split by line in the first pass.

### Tag resolution

```typescript
function resolveTag(el: Element): string {
  let cur = el;
  while (cur && cur !== document.body) {
    const tag = cur.tagName;
    if (tag === "PRE" || tag === "CODE" || tag === "A" || tag === "H1" || ...) return tag;
    cur = cur.parentElement;
  }
  return el.tagName || "BODY";
}
```

Walks up from a text node's parent to find the most semantically meaningful ancestor. A text node inside `<a><span>Click here</span></a>` resolves to `"A"`, not `"SPAN"`.

### DOM-aware context

```typescript
function getDomContext(node: Node, matchText: string, tag: string): string[] {
  if (tag === "PRE" || tag === "CODE") {
    // Find the <pre> block, split into lines, return surrounding lines
    const lines = codeBlock.textContent.split("\n");
    const start = Math.max(0, matchIdx - CONTEXT_LINES);
    const end = Math.min(lines.length, matchIdx + CONTEXT_LINES + 1);
    return lines.slice(start, end);
  }
  // For prose: walk up to block container, extract text
  // ...
}
```

Context is extracted from the DOM structure, not from the flat line array. For code blocks, this means showing 5 lines above and below the match from the same `<pre>` element. For prose, it finds the nearest block container (paragraph, div, article) and returns its text.

### Early exit

```typescript
if (scored.length >= MAX_RESULTS * 3) break;
```

After collecting 600 scored results, stop scanning. The top 200 after sorting are returned. This prevents slowdown on pages with 50,000+ text lines.

---

## Scroll-to-Text — scroll.ts

Navigates to a search result by scrolling to its DOM position and applying a temporary yellow highlight.

### Fast path / slow path

```typescript
export function scrollToText(text: string, nodeRef?: WeakRef<Node>): void {
  const cached = nodeRef?.deref();
  if (cached && document.body.contains(cached)) {
    scrollToElement(cached, text);
    return;
  }
  // Slow path: walk all text nodes
  const walker = document.createTreeWalker(...);
  // ...
}
```

If the `WeakRef` from the grep result is still alive and in the document, use it directly (O(1)). If the node was garbage collected or removed from the DOM, fall back to a full text node walk (O(n)).

### Temporary highlight

```typescript
function highlightTextNode(node: Node, text: string): void {
  const range = document.createRange();
  range.setStart(node, idx);
  range.setEnd(node, idx + text.length);

  const highlight = document.createElement("mark");
  range.surroundContents(highlight);

  setTimeout(() => {
    highlight.style.opacity = "0";
    setTimeout(() => {
      const textNode = document.createTextNode(highlight.textContent);
      highlight.parentNode.replaceChild(textNode, highlight);
      textNode.parentNode.normalize();
    }, 500);
  }, 2000);
}
```

Uses the Range API to wrap the exact matched text in a `<mark>` element. After 2 seconds, fades it out (500ms transition), then replaces the `<mark>` with a plain text node. `normalize()` merges adjacent text nodes that the Range split apart — without this, subsequent searches would find fragmented text nodes.

`range.surroundContents()` can throw if the range crosses element boundaries. The `try/catch` silently handles this edge case.

---

## Frecency Algorithm — frecency.ts

Self-contained module managing tab visit tracking with Mozilla-style frecency scoring.

### Time-decay buckets

```typescript
function computeFrecencyScore(entry: FrecencyEntry): number {
  const age = Date.now() - entry.lastVisit;
  let recencyWeight: number;
  if (age < 4 * MINUTE)   recencyWeight = 100;
  else if (age < HOUR)    recencyWeight = 70;
  else if (age < DAY)     recencyWeight = 50;
  else if (age < WEEK)    recencyWeight = 30;
  else                    recencyWeight = 10;
  return entry.visitCount * recencyWeight;
}
```

Discrete buckets instead of continuous decay. Why:
1. Simpler to reason about ("tabs visited in the last 4 minutes are 10x more important than week-old tabs")
2. No floating point precision issues
3. Easy to tune — adjust thresholds without changing formulas

A tab visited 5 times in the last 4 minutes: `5 × 100 = 500`. Same tab after a day: `5 × 50 = 250`. Visited once last week: `1 × 30 = 30`.

### Lowest-score eviction

```typescript
if (frecencyMap.size > MAX_FRECENCY_ENTRIES) {
  let lowestId = null;
  let lowestScore = Infinity;
  for (const [id, e] of frecencyMap) {
    if (e.frecencyScore < lowestScore) {
      lowestScore = e.frecencyScore;
      lowestId = id;
    }
  }
  if (lowestId !== null) frecencyMap.delete(lowestId);
}
```

O(n) scan with n=50. A min-heap would be O(log n) but adds complexity for negligible gain at this scale.

Not FIFO (first in, first out) because that would evict frequently visited old tabs. Not LRU (least recently used) because that ignores visit frequency. Frecency balances both.

### Reconciliation with open tabs

```typescript
export async function getFrecencyList(): Promise<FrecencyEntry[]> {
  const tabs = await browser.tabs.query({ currentWindow: true });
  const tabIds = new Set(tabs.map((t) => t.id));

  // Prune closed tabs
  for (const id of frecencyMap.keys()) {
    if (!tabIds.has(id)) frecencyMap.delete(id);
  }

  // Add untracked tabs with score 0
  const entries = tabs.map((t) => {
    const existing = frecencyMap.get(t.id);
    if (existing) return { ...existing, frecencyScore: computeFrecencyScore(existing) };
    return { tabId: t.id, frecencyScore: 0, ... };
  });

  entries.sort((a, b) => b.frecencyScore - a.frecencyScore);
  return entries;
}
```

Scores are recomputed on read (not just on write) because the recency weight changes over time. A tab visited 5 minutes ago might have moved from the "4-minute" bucket to the "hour" bucket since last computation.

---

## Session Management — sessions.ts

CRUD handlers for harpoon sessions, extracted from background.ts for modularity.

### HarpoonState interface

```typescript
export interface HarpoonState {
  getList(): HarpoonEntry[];
  setList(list: HarpoonEntry[]): void;
  recompactSlots(): void;
  save(): Promise<void>;
  ensureLoaded(): Promise<void>;
}
```

This interface decouples session management from the background script's global state. The background creates a `harpoonState` object that implements this interface:

```typescript
const harpoonState: HarpoonState = {
  getList: () => harpoonList,
  setList: (list) => { harpoonList = list; },
  // ...
};
```

This is dependency injection without a DI framework. The sessions module doesn't know about `harpoonList` — it only knows the interface. This makes the module testable (you could pass a mock state) and prevents circular dependencies.

### Save validation

```typescript
export async function sessionSave(state, name): Promise<{ ok: boolean; reason?: string }> {
  if (state.getList().length === 0) return { ok: false, reason: "Cannot save empty harpoon list" };
  const nameTaken = sessions.some((s) => s.name.toLowerCase() === name.toLowerCase());
  if (nameTaken) return { ok: false, reason: `"${name}" already exists` };
  if (sessions.length >= 4) return { ok: false, reason: "Max 4 sessions — delete one first" };
  // ...
}
```

Multiple validation gates:
1. Empty list check
2. Case-insensitive duplicate name check
3. Max capacity (4 sessions)

Returns `{ ok: false, reason }` instead of throwing. The caller decides how to display the error (toast, inline message, etc.).

### Session load — new tabs

```typescript
export async function sessionLoad(state, name): Promise<...> {
  for (const entry of session.entries) {
    const tab = await browser.tabs.create({ url: entry.url, active: false });
    newList.push({ tabId: tab.id!, url: entry.url, ... });
  }
  state.setList(newList);
  // Activate the first tab
  await browser.tabs.update(newList[0].tabId, { active: true });
}
```

Each session entry opens a new tab. `active: false` prevents tab focus from jumping around during creation. After all tabs are created, the first one is activated.

The harpoon list is **replaced** entirely — session load doesn't append to the existing list. This is intentional: a session represents a complete workspace.

---

## Harpoon Overlay — harpoon-overlay.ts

The Tab Manager panel. 525 lines implementing: list rendering, keyboard navigation, swap mode, session sub-views, and number key jumps.

### View mode state machine

```typescript
type ViewMode = "harpoon" | "saveSession" | "sessionList" | "replaceSession";
let viewMode: ViewMode = "harpoon";
```

The harpoon panel has four sub-views, all rendered inside the same panel container. `render()` dispatches to the right renderer:

```typescript
function render(): void {
  switch (viewMode) {
    case "harpoon": renderHarpoon(); break;
    case "saveSession": renderSaveSession(sessionCtx); break;
    case "sessionList": renderSessionList(sessionCtx); break;
    case "replaceSession": renderReplaceSession(sessionCtx); break;
  }
}
```

Escape from session views goes back to harpoon view (`setViewMode("harpoon")`), not close the panel. This is explicit in the keyboard handlers.

### Session context — cross-module communication

```typescript
const sessionCtx: SessionContext = {
  shadow, container, config,
  get sessions() { return sessions; },
  get sessionIndex() { return sessionIndex; },
  setSessionIndex(i) { sessionIndex = i; },
  setSessions(s) { sessions = s; },
  setViewMode(mode) { viewMode = mode; },
  render, close,
};
```

The `SessionContext` object provides session-views.ts with controlled access to the harpoon overlay's state. Getters and setters maintain encapsulation — the session module can read/write state but doesn't directly hold the variables.

### Swap mode

```typescript
let swapMode = false;
let swapSourceIndex: number | null = null;

function performSwapPick(idx: number): void {
  if (swapSourceIndex === null) {
    swapSourceIndex = idx;     // first pick: set source
    render();
  } else if (swapSourceIndex === idx) {
    swapSourceIndex = null;    // same item: deselect
    render();
  } else {
    // Different item: perform swap
    const temp = list[srcIdx];
    list[srcIdx] = list[idx];
    list[idx] = temp;
    swapSourceIndex = null;    // Clear source, stay in swap mode
    // Save reorder to background
    browser.runtime.sendMessage({ type: "HARPOON_REORDER", list });
  }
}
```

Swap mode stays active after completing a swap. The user can keep swapping until pressing `w` again or Escape. `swapSourceIndex = null` resets the "pick" without exiting swap mode.

The visual indicator: source item gets `.swap-source` class (blue background + yellow border). This is distinct from `.active` (blue border only).

### Number key instant jump

```typescript
if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
  const num = parseInt(e.key);
  if (num >= 1 && num <= MAX_HARPOON_SLOTS) {
    const item = list.find((it) => it.slot === num);
    if (item) jumpToSlot(item);
    return;
  }
}
```

Number keys 1-4 instantly jump to the corresponding slot — no selection, no confirmation. The modifier check (`!e.ctrlKey && ...`) ensures `Alt+1` (which is a global shortcut) doesn't trigger this.

### Class swap for navigation

```typescript
function setActiveIndex(newIndex: number): void {
  const prev = harpoonList.querySelector(".ht-harpoon-item.active");
  if (prev) prev.classList.remove("active");
  activeIndex = newIndex;
  const next = harpoonList.querySelector(`.ht-harpoon-item[data-index="${activeIndex}"]`);
  if (next) {
    next.classList.add("active");
    next.scrollIntoView({ block: "nearest" });
  }
}
```

Arrow key navigation doesn't rebuild the DOM. It swaps CSS classes on existing elements. For a list of 4 items, this is negligible — but it's the right pattern to use everywhere.

When swap mode is active, arrow navigation does trigger `render()` because the swap indicators need updating (which items are highlighted as source/target).

---

## Telescope Overlay — search-overlay.ts

The most complex UI component. 850 lines implementing: fuzzy search input, structural filter pills, virtual scrolling results, preview pane with code/prose rendering, and highlight matching.

### Page size safety guard

```typescript
const elementCount = document.body.querySelectorAll("*").length;
const textLength = document.body.textContent?.length ?? 0;
if (elementCount > MAX_DOM_ELEMENTS || textLength > MAX_TEXT_BYTES) {
  showFeedback("Page too large to search");
  return;
}
```

200,000+ DOM elements or 10MB+ text content would make grep unresponsive. The guard checks before building the UI, avoiding a hung panel.

### Filter parsing

```typescript
function parseInput(raw: string): { filters: SearchFilter[]; query: string } {
  const tokens = raw.trimStart().split(/\s+/);
  const filters: SearchFilter[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (VALID_FILTERS[tokens[i]]) {
      filters.push(VALID_FILTERS[tokens[i]]);
    } else break;  // first non-filter token starts the query
  }
  const query = tokens.slice(queryStart).join(" ").trim();
  return { filters, query };
}
```

Stateless — re-parses from scratch on every keystroke. Filters must be at the start of input. `/code api` is valid (filter + query). `api /code` is just a query "api /code". This is simpler than tracking filter state separately.

The `break` on non-filter token is important: `/code /links api endpoint` parses as two filters and query "api endpoint". Partial filters like `/cod` don't match because `VALID_FILTERS` is an exact dictionary.

### Backspace removes filter pills

```typescript
if (e.key === "Backspace" && input.value === "" && activeFilters.length > 0) {
  activeFilters.pop();
  input.value = activeFilters.map((f) => `/${f}`).join(" ") + " ";
  // Re-trigger search
}
```

When input is empty and the user presses Backspace, the last filter pill is removed. The input is rebuilt from remaining filters. This is a "tag-input" UX pattern common in email clients and search UIs.

### Virtual scrolling

The results pane can contain 200 results. Rendering 200 DOM elements with event listeners is slow. Virtual scrolling renders only the ~25 visible items.

```
┌─ Results Pane (overflow: auto) ──────────┐
│  ┌─ Sentinel (height: results × 28px) ──┐│  ← Creates scrollbar
│  │                                       ││
│  └───────────────────────────────────────┘│
│  ┌─ Results List (position: absolute) ───┐│  ← Contains ~25 items
│  │  Item 12                              ││
│  │  Item 13 (active)                     ││
│  │  Item 14                              ││
│  │  ...                                  ││
│  └───────────────────────────────────────┘│
└──────────────────────────────────────────┘
```

**Sentinel** — An empty div sized to the total scrollable height (`results.length * ITEM_HEIGHT`). This gives the scrollbar the correct size. It has no content.

**Results List** — Positioned absolutely at `top: vsStart * ITEM_HEIGHT`. Contains only the items visible in the viewport plus a buffer of 5 items above and below.

```typescript
function renderVisibleItems(): void {
  const scrollTop = resultsPane.scrollTop;
  const viewHeight = resultsPane.clientHeight;
  const newStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - POOL_BUFFER);
  const newEnd = Math.min(results.length, Math.ceil((scrollTop + viewHeight) / ITEM_HEIGHT) + POOL_BUFFER);
  if (newStart === vsStart && newEnd === vsEnd) return;
  // Re-bind pool items to new result indices
}
```

The scroll listener triggers `renderVisibleItems()`, which calculates the visible range and re-binds pool items to new data. The early return (`if unchanged`) prevents unnecessary DOM work.

### Element pool

```typescript
function getPoolItem(poolIdx: number): HTMLElement {
  if (poolIdx < itemPool.length) return itemPool[poolIdx];
  const item = document.createElement("div");
  item.className = "ht-result-item";
  const badge = document.createElement("span"); // tag badge
  const span = document.createElement("span");  // text
  item.appendChild(badge);
  item.appendChild(span);
  itemPool.push(item);
  return item;
}
```

DOM elements are created once and reused. `bindPoolItem()` updates the content of an existing element for a new result index. The DOM structure (badge + text span) is created once; only `textContent`, `innerHTML`, `style`, and class are updated on rebind.

### Event delegation

```typescript
resultsList.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest(".ht-result-item");
  if (!item || !item.dataset.index) return;
  setActiveIndex(Number(item.dataset.index));
});
```

One click listener on the container handles clicks on any result item. `closest()` walks up from the click target to find the nearest `.ht-result-item`. This works regardless of how many items exist, whether they're recycled, or whether the user clicked on the badge or the text inside the item.

### Preview rendering

```typescript
function updatePreview(): void {
  const r = results[activeIndex];
  const contextLines = r.domContext || r.context || [r.text];
  const isCode = tag === "PRE" || tag === "CODE";

  if (isCode) {
    html += '<div class="ht-preview-code-ctx">';
    for (const line of contextLines) {
      const isMatch = trimmed === r.text;
      html += `<span class="${cls}">${lineContent}</span>`;
    }
  } else {
    // Prose rendering
  }
}
```

Preview uses DOM-aware context (from `getDomContext()`) when available, with flat context as fallback. Code blocks get monospace font and line numbers. Prose gets clean text blocks. The matched line is highlighted with a blue left border.

### rAF-throttled preview updates

```typescript
function schedulePreviewUpdate(): void {
  if (previewRafId !== null) return;
  previewRafId = requestAnimationFrame(() => {
    previewRafId = null;
    updatePreview();
  });
}
```

Rapid arrow key navigation schedules multiple preview updates. `requestAnimationFrame` coalesces them into one per paint frame. The `if (previewRafId !== null) return` guard prevents scheduling multiple rAFs — only one is pending at a time.

### j/k in search input

```typescript
if (matchesAction(e, config, "search", "moveDown")) {
  const lk = e.key.toLowerCase();
  if ((lk === "j" || lk === "k") && inputFocused) return;
  // navigate
}
```

When the search input is focused, `j` and `k` type into the input (for searching). When the results list is focused, they navigate. This prevents vim keys from hijacking text input.

---

## Bookmark Overlay — bookmark-overlay.ts

The largest overlay. 1954 lines implementing: two-pane bookmark browser with virtual scrolling, fuzzy filter with slash commands, detail/move/tree/delete modes, folder picker, add-bookmark wizard, and tree view with open confirmation.

This file exports two independent overlays:
1. `openBookmarkOverlay(config)` — the main browse/filter/manage overlay
2. `openAddBookmarkOverlay(config)` — a standalone "Add Bookmark" wizard

Both are self-contained closures: own shadow DOM panel, own keyboard handler, own state.

### Two-pane layout with virtual scrolling

Same architecture as the telescope overlay:
- **Left pane (40%)**: bookmark results list with virtual scrolling (`ITEM_HEIGHT = 52`, `POOL_BUFFER = 5`, sentinel + element pool)
- **Right pane (60%)**: context-dependent detail view controlled by `detailMode`

Virtual scrolling uses the same pattern as telescope: a sentinel div sized to `filtered.length * ITEM_HEIGHT` creates the scrollbar, an absolutely-positioned results list contains only the visible items plus buffer, and an element pool (`getPoolItem()` / `bindPoolItem()`) reuses DOM elements. A passive scroll listener triggers `renderVisibleItems()`, which short-circuits if the visible range hasn't changed.

### Slash filters

Two bookmark-specific filters parsed from leading input tokens:

| Token | Filter | Effect |
|-------|--------|--------|
| `/folder` | `"folder"` | Matches query against folder path only |
| `/file` | `"file"` | Matches query against URL only |

Both filters together: union (matches folder path OR URL). No filters: matches against title, URL, or folder path. Backspace on empty input removes the last filter pill.

### Detail mode state machine

```typescript
let detailMode: "detail" | "move" | "tree" | "confirmDelete" | "confirmMove" = "detail";
```

| Mode | Right pane shows | Entered via | Exited via |
|------|-----------------|-------------|------------|
| `"detail"` | Bookmark fields (title, URL, path, date, stats) | Default / return from any mode | N/A (home state) |
| `"move"` | Folder picker list | `m` key (results pane focused) | `Escape`, `m` again, or selecting a folder |
| `"tree"` | Full bookmark tree with collapsible folders | `t` key (results pane focused) | `Escape`, `t` again |
| `"confirmDelete"` | Delete confirmation dialog | `d` key (results pane focused) | `y`/`Enter` (deletes) or `n`/`Escape` (cancels) |
| `"confirmMove"` | Move confirmation with from/to paths | `Enter` in move mode | `y`/`Enter` (moves) or `n`/`Escape` (cancels) |

Every mode transition calls `updateFooter()` to swap footer hints. The keyboard handler checks `detailMode` first, creating isolated key contexts for each mode.

### Move mode — folder picker

When `m` is pressed:
1. `moveFolders` is populated from `flatFolderList` (excluding the invisible root at depth 0)
2. `moveTargetIndex` tracks the highlighted folder
3. j/k or arrows navigate the folder list
4. `Enter` sets `pendingMoveEntry` and `pendingMoveParentId`, transitions to `"confirmMove"`
5. On confirm, sends `BOOKMARK_MOVE` to background, re-fetches the full bookmark list to refresh folder paths

The move confirmation dialog reconstructs the full destination path by walking ancestors backward through `moveFolders` using depth comparison, displaying source path → destination path with an arrow.

### Tree view

The tree shows the full bookmark folder hierarchy with entries nested inside their parent folders.

**Core data structures:**

| Variable | Type | Purpose |
|----------|------|---------|
| `folderTree` | `BookmarkFolder[]` | Raw folder tree from background (`BOOKMARK_FOLDERS` message) |
| `flatFolderList` | `{ id, title, depth }[]` | Depth-first flattened folder tree, created by `flattenFolders()` at startup |
| `byParent` | `Map<string, BookmarkEntry[]>` | Built fresh each render — groups `allEntries` by `parentId` |
| `treeVisibleItems` | `{ type: "folder" \| "entry"; id: string }[]` | Flat list of currently visible nodes, rebuilt each render |
| `treeCollapsed` | `Set<string>` | Collapsed folder IDs. Toggling resets on exit/re-enter |
| `treeCursorIndex` | `number` | Index into `treeVisibleItems` for cursor position |

**`renderTreeView()` implementation:**
1. Builds `byParent` map from `allEntries`
2. Iterates `flatFolderList`, skipping depth-0 root
3. For each folder: emits a `.ht-bm-tree-node` div with collapse arrow (`▶`/`▼`), folder icon, title, child count. Indentation: `(depth - 1) * 14` px
4. If folder is expanded: emits each child bookmark as `.ht-bm-tree-entry` with file icon, title, domain (`extractDomain()`). Entry indentation: folder indent + 14px
5. Simultaneously builds `treeVisibleItems` array
6. Clamps `treeCursorIndex`, scrolls cursor into view

**Cursor movement (`moveTreeCursor()`)**: CSS class swap only — removes `tree-cursor` from old element, adds to new. No re-render. Uses `data-tree-idx` attributes for efficient element lookup.

**Collapse toggling (`toggleTreeCollapse()`)**: Full re-render via `renderTreeView()` since the visible items list changes.

### Open confirmation sub-state

`pendingTreeOpenEntry: BookmarkEntry | null` is a **sub-state within** `detailMode === "tree"`. When non-null, the tree keyboard handler routes to a confirmation dialog instead of normal tree navigation.

- **Entry**: `Enter` on an entry node, or double-click on an entry
- **Rendering**: Shows bookmark title in quotes, optional folder path underneath, and `y / Enter confirm | n / Esc cancel` hint
- **Resolution**: `y`/`Enter` opens the bookmark; `n`/`Escape` clears and returns to tree navigation

### Click vs dblclick — DOM preservation

The critical pattern: single-click handlers that coexist with dblclick must NOT rebuild DOM (via `innerHTML` or full re-render), or the dblclick event loses its target between the two clicks.

**Left pane results:**
- Single click: calls `setActiveIndex()` — CSS class swap, no DOM rebuild
- Dblclick: immediately opens the bookmark

**Tree view entries:**
- Single click on folder: toggles collapse (full re-render — safe because folders have no dblclick action)
- Single click on entry: CSS-only cursor swap (no re-render, preserves DOM for dblclick)
- Dblclick on entry: sets `pendingTreeOpenEntry`, shows open confirmation

### Add Bookmark overlay — three-step wizard

Exported as `openAddBookmarkOverlay()`. Completely separate panel with its own lifecycle.

```typescript
type Step = "chooseType" | "chooseDest" | "nameInput";
```

| Step | UI | Enter action | Escape action |
|------|----|-------------|---------------|
| `chooseType` | Two items: "File" (save page) / "Folder" (create folder) | Sets `chosenType`, moves to `chooseDest` | Closes overlay |
| `chooseDest` | Folder picker with "Root (no folder)" at top | For file: sends `BOOKMARK_ADD`, closes. For folder: moves to `nameInput` | Back to `chooseType` |
| `nameInput` | Name input field for new folder | Validates, sends `BOOKMARK_CREATE_FOLDER`, closes | Back to `chooseDest` |

The `chooseType` and `chooseDest` steps share navigation logic (j/k or arrows, same `totalItems` counting). Only `nameInput` has its own keyboard block (passes keys through to the input element).

### `shortPath()` — compact folder display

```typescript
function shortPath(folderPath: string): string {
  const segments = folderPath.split(" › ");
  return segments.length > 2
    ? segments.slice(-2).join(" › ")
    : folderPath;
}
```

Truncates folder paths to the last 2 segments for the results list. Full path is shown in the detail view.

### Footer conventions

| Mode | Footer |
|------|--------|
| `"detail"` | `j/k nav` \| `Tab list` \| `Enter open` \| `Esc close` / `t tree (toggle)` \| `m move` \| `d remove` |
| `"move"` | `j/k nav` \| `Enter confirm` \| `Esc / m back` |
| `"tree"` (no pending) | `j/k nav` \| `Enter fold/open` \| `Esc / t back` |
| `"tree"` (pending open) | `y / Enter confirm` \| `n / Esc cancel` |
| `"confirmDelete"` | `y / Enter confirm` \| `n / Esc cancel` |
| `"confirmMove"` | `y / Enter confirm` \| `n / Esc cancel` |

---

## History Overlay — history-overlay.ts

1317 lines implementing: two-pane history browser with virtual scrolling, fuzzy filter with time-based slash commands, detail/delete/tree modes, time bucket tree view, and in-place history deletion.

### Two-pane layout with virtual scrolling

Same architecture as the bookmark overlay:
- **Left pane (40%)**: history results list with virtual scrolling (`ITEM_HEIGHT = 52`, `POOL_BUFFER = 5`, `MAX_HISTORY = 200`)
- **Right pane (60%)**: context-dependent detail view

History entries are fetched from the background via `HISTORY_LIST` message (which calls `browser.history.search()` with `maxResults: 200`). Entries are sorted by `lastVisitTime` descending.

### Slash filters — time ranges

Three time-based filters:

| Token | Filter | Range |
|-------|--------|-------|
| `/today` | `"today"` | Last 24 hours |
| `/week` | `"week"` | Last 7 days |
| `/month` | `"month"` | Last 30 days |

Multiple filters stack with the widest range (most permissive union). These are orthogonal to the tree view's time buckets — filters affect the left pane's `filtered` list; time buckets organize the tree view.

### Detail mode state machine

```typescript
let detailMode: "detail" | "confirmDelete" | "tree" = "detail";
```

Simpler than bookmarks — no move mode. The keyboard handler checks `detailMode` first.

| Mode | Right pane shows | Entered via | Exited via |
|------|-----------------|-------------|------------|
| `"detail"` | History detail fields (title, URL, visit time, visit count) | Default / return from any mode | N/A (home state) |
| `"confirmDelete"` | Delete confirmation dialog | `d` key (results pane focused) | `y`/`Enter` (deletes) or `n`/`Escape` |
| `"tree"` | Time bucket tree with entries nested inside | `t` key (results pane focused) | `Escape`, `t` again |

### Time bucket classification

`buildTimeBuckets()` classifies entries into six fixed time buckets:

| Bucket | Age range |
|--------|-----------|
| Today | `< 1 day` |
| Yesterday | `1-2 days` |
| This Week | `2-7 days` |
| Last Week | `7-14 days` |
| This Month | `14-30 days` |
| Older | `>= 30 days` |

Each bucket has a label, an icon, and an array of entries. Empty buckets are skipped during tree rendering.

### Tree view — time buckets as folders

The tree shows time buckets as top-level collapsible nodes with history entries nested inside.

**`renderTreeView()` implementation:**
1. Calls `buildTimeBuckets(filtered)` — operates on already-filtered entries
2. For each non-empty bucket: emits a bucket header node with collapse arrow, icon, label, and count
3. If bucket is expanded: emits each child entry with document icon, title, and domain
4. Simultaneously builds `treeVisibleItems` array

**`treeVisibleItems`**: Flat array of `{ type: "bucket" | "entry"; id: string }`. Bucket IDs are label strings (e.g., `"Today"`). Entry IDs use the composite format (see below).

### Entry IDs — `${lastVisitTime}:${url}`

History entries need unique identification in the tree. The composite string format `"${lastVisitTime}:${url}"` is used because history can contain duplicate URLs with different visit times.

Parsing uses `indexOf(":")` to find the first colon — safe because URLs always contain colons (`https://...`), so the timestamp is everything before the first colon, and the URL is everything after:

```typescript
const sepIdx = item.id.indexOf(":");
const ts = Number(item.id.substring(0, sepIdx));
const url = item.id.substring(sepIdx + 1);
```

### History API

- **Fetch**: `browser.runtime.sendMessage({ type: "HISTORY_LIST", maxResults: 200 })` — routed to background which calls `browser.history.search({ text: "", maxResults: 200, startTime: 0 })`
- **Delete**: `browser.history.deleteUrl({ url })` — called directly. After deletion, the entry is removed from the local `allEntries` array and filters are re-applied

### Open confirmation sub-state

Same pattern as bookmarks: `pendingTreeOpenEntry: HistoryEntry | null` is a sub-state within tree mode. Shows the entry title and domain with `y / Enter confirm | n / Esc cancel`. Priority check at the top of the tree keyboard handler.

### `relativeTime()` — human-readable timestamps

```typescript
function relativeTime(ts: number): string
```

Converts timestamps to compact relative strings: `"just now"`, `"5m ago"`, `"3h ago"`, `"2d ago"`, `"1w ago"`, `"3mo ago"`, `"1y ago"`. Used in both the results list (as a blue time tag) and the detail pane's "Last Visited" field.

### Opening behavior

`openHistoryEntry()` first checks if the URL is already open in the current window (`browser.tabs.query`). If found, switches to that tab. Otherwise creates a new tab.

### Footer conventions

| Mode | Footer |
|------|--------|
| `"detail"` | `j/k nav` \| `Tab list` \| `t tree (toggle)` \| `d remove` \| `Enter open` \| `Esc close` |
| `"confirmDelete"` | `y / Enter confirm` \| `n / Esc cancel` |
| `"tree"` (no pending) | `j/k nav` \| `Enter fold/open` \| `Esc / t back` |
| `"tree"` (pending open) | `y / Enter confirm` \| `n / Esc cancel` |

---

## Frecency Overlay — frecency-overlay.ts

A simpler panel listing all open tabs sorted by frecency score. 403 lines with type-to-filter, DocumentFragment rendering, and class-swap navigation.

### Static shell + dynamic list

The panel structure (titlebar, input, list container, footer) is built once from DOM elements:

```typescript
const titlebar = document.createElement("div");
const input = document.createElement("input");
const listEl = document.createElement("div");
const footer = document.createElement("div");
panel.appendChild(titlebar);
panel.appendChild(inputWrap);
panel.appendChild(listEl);
panel.appendChild(footer);
```

Only `listEl` is updated on filter changes. The input element is never destroyed, so typing is never interrupted. This pattern was born from the [frecency input destruction bug](#the-frecency-input-destruction-bug).

### DocumentFragment rendering

```typescript
function buildListFragment(): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const entry of filtered) {
    const item = document.createElement("div");
    // ... build item
    frag.appendChild(item);
  }
  return frag;
}

function commitList(frag: DocumentFragment): void {
  listEl.textContent = "";
  listEl.appendChild(frag);
}
```

`DocumentFragment` is not rendered. Items are built off-DOM, then moved to the live DOM in a single `appendChild()`. This avoids the "flash of empty" that `innerHTML = ""` followed by `innerHTML = html` causes.

### Synchronous first render + rAF subsequent

```typescript
let firstRender = true;

function renderList(): void {
  if (firstRender) {
    firstRender = false;
    commitList(buildListFragment());
    return;
  }
  cancelAnimationFrame(renderRafId);
  renderRafId = requestAnimationFrame(() => {
    commitList(buildListFragment());
  });
}
```

Without synchronous first render, the panel opens empty for one frame, then content appears. Users see a flash. First render is synchronous to eliminate this. Subsequent renders are deferred to rAF to coalesce rapid updates.

### Class swap navigation

```typescript
function updateActiveHighlight(newIndex: number): void {
  if (activeItemEl) activeItemEl.classList.remove("active");
  activeIndex = newIndex;
  const items = listEl.querySelectorAll(".ht-frecency-item");
  activeItemEl = items[activeIndex] as HTMLElement;
  if (activeItemEl) {
    activeItemEl.classList.add("active");
    activeItemEl.scrollIntoView({ block: "nearest" });
  }
}
```

Arrow keys only swap classes. The DOM is not rebuilt. This eliminates the [frecency flicker bug](#the-frecency-flicker-bug).

---

## Help Overlay — help-overlay.ts

708 lines implementing an interactive quick-reference overlay with fuzzy search, slash section-filters with pills, collapsible sections, and cursor navigation. Shows all keybindings organized into user-facing sections with live config reflection. Opened with `Alt+M`.

### Manual section building

Earlier iterations auto-generated sections from `ACTION_LABELS` and `SCOPE_LABELS` (exported from `keybindings.ts`), but this was replaced with manual `buildSections()` for full control over section order, naming, and content:

```typescript
function buildSections(config: KeybindingsConfig): HelpSection[] {
  const g = config.bindings.global;
  return [
    { title: "Open Panels", items: [
      { label: "Search Current Page", key: k(g.searchInPage) },
      { label: "Tab Manager", key: k(g.openHarpoon) },
      // ...
    ]},
    { title: "Vim Mode (optional)", items: [...] },
    // ... 7 sections total
  ];
}
```

Sections still reflect live keybindings — `keyToDisplay()` converts the user's current config into display strings. The manual approach just controls which items appear where and what they're called (e.g. "Tab Manager" instead of "Harpoon", "Search Current Page" instead of "searchInPage").

### FlatEntry model for unified navigation

The overlay flattens all sections into a single `FlatEntry[]` array, where each entry is either a `"header"` (section title) or an `"item"` (keybinding row):

```typescript
interface FlatEntry {
  type: "header" | "item";
  sectionIndex: number;
  itemIndex?: number;
  label: string;
  key?: string;
  searchText: string;  // lowercase for matching
}
```

This is the same pattern as `treeVisibleItems` in the bookmark/history overlays — flatten a hierarchical structure into a single array so cursor navigation is just index arithmetic. `activeIndex` is an index into this flat array, and `data-flat-index` attributes on DOM elements enable O(1) element lookup.

### Fuzzy search with highlight

Typing in the search input filters across all sections. `buildFuzzyPattern()` creates a regex that matches characters in order with gaps (same approach as frecency-overlay.ts). Sections with zero matching items are hidden entirely; the header is still shown if any child matches.

`highlightMatch()` wraps matching characters in `<mark>` tags for visual feedback. This uses term-level matching (not character-level) — each whitespace-separated search term is highlighted independently.

### Collapsible sections

Each section can be folded/unfolded. State is tracked in a `Set<number>` of collapsed section indices. When collapsed:
- The chevron rotates 90° (`transform: rotate(-90deg)` via CSS transition)
- Child items get `display: none` via the `.collapsed` class
- `buildFlat()` skips emitting child `FlatEntry` items for collapsed sections

Enter on a header toggles the fold. This triggers a full `render()` because the flat array changes shape. Cursor movement within an expanded section is CSS-only (class swap, no re-render).

### Tab switching between input and results

Tab cycles focus between the search input and the results body. When the body is focused, the `"focused"` class is added to `.ht-help-body`, which changes the active highlight from blue tint to white tint — a visual cue for which pane has focus. j/k navigation (vim mode) is blocked while the input is focused, allowing normal typing.

### Active highlight — CSS swap without re-render

`updateActiveHighlight()` swaps the `.active` class between two elements using `data-flat-index` lookup:

```typescript
function updateActiveHighlight(newIndex: number): void {
  const oldEl = body.querySelector(`[data-flat-index="${activeIndex}"]`);
  if (oldEl) oldEl.classList.remove("active");
  activeIndex = newIndex;
  const newEl = body.querySelector(`[data-flat-index="${activeIndex}"]`);
  if (newEl) { newEl.classList.add("active"); newEl.scrollIntoView({ block: "nearest" }); }
}
```

This follows the same O(1) pattern used by all other overlays. Full `render()` only happens on search input changes or section fold/unfold — not on every cursor move.

### Slash section-filters with pills

Like the search overlay's `/code`, `/headings` filters and the bookmark overlay's `/folder`, `/file`, the help overlay supports slash filters that scope results to specific sections:

```typescript
const SECTION_FILTERS: Record<string, string> = {
  "/panels": "Open Panels",
  "/vim": "Vim Mode (optional)",
  "/common": "Inside Any Panel",
  "/tabs": "Tab Manager Panel",
  "/bookmarks": "Bookmarks Panel",
  "/history": "History Panel",
  "/filters": "Search Filters — type in search input",
};
```

`parseInput()` follows the same pattern as the search overlay — slash tokens at the start of the input are extracted as filters, the remainder becomes the fuzzy query. Typing `/tabs swap` shows only the Tab Manager Panel section, filtered to items matching "swap".

Filter pills appear below the input (same CSS as search overlay pills). Clicking × on a pill removes that token from the input and re-triggers the input handler via `dispatchEvent(new Event("input"))`.

Multiple filters combine as a union: `/tabs /bookmarks` shows both sections.

### Two-row footer with mouse hints

The help overlay is the only panel with explicit mouse interaction hints in the footer, since it serves as the reference for all panels:

```
Row 1: j/k (vim) ↑/↓ nav | click select | wheel scroll
Row 2: Tab list | enter fold | Esc close
```

Row 1 covers all navigation methods (keyboard + mouse). Row 2 covers actions. This follows the convention order: nav → secondary → action → close.

---

## Session Views — session-views.ts

594 lines implementing four views: save session, session list, replace session picker, and standalone session restore (browser startup).

### SessionContext pattern

The harpoon overlay passes a `SessionContext` object that gives session views controlled access to its internal state. This avoids circular imports and keeps the session module independent.

The context uses getters for read access and setter functions for write access:

```typescript
get sessions() { return sessions; },
get sessionIndex() { return sessionIndex; },
setSessionIndex(i) { sessionIndex = i; },
setViewMode(mode) { viewMode = mode; },
render() { ... },
```

### Save validation

```typescript
async function validateSessionSave(name: string): Promise<string | null> {
  const [harpoonList, sessions] = await Promise.all([...]);
  // Check identical content
  const currentUrls = harpoonList.map((e) => e.url).join("\n");
  for (const s of sessions) {
    if (currentUrls === s.entries.map((e) => e.url).join("\n"))
      return `Identical to "${s.name}"`;
  }
  // Check duplicate name
  if (s.name.toLowerCase() === name.toLowerCase())
    return `"${s.name}" already exists`;
  return null;
}
```

Two checks beyond what `sessionSave()` in sessions.ts does:
1. Content identity — saving the exact same URL set under a different name is likely a mistake
2. Name collision — case-insensitive

These run before the save attempt, so the user sees the error in the save input (red border + error text), not as a toast after the fact.

### Replace flow

When saving at max capacity (4 sessions):
1. `sessionSave()` returns `{ ok: false, reason: "Max 4 sessions" }`
2. The handler switches to `replaceSession` view
3. User picks a session to replace
4. The old session is deleted, new one saved with the pending name

### Standalone restore overlay

```typescript
export async function openSessionRestoreOverlay(): Promise<void> {
  const sessions = await browser.runtime.sendMessage({ type: "SESSION_LIST" });
  const config = await loadKeybindings();
  const { host, shadow } = createPanelHost();
  // Build a simpler panel: just a session list with Enter to restore
}
```

This is a standalone panel (not inside the harpoon overlay) shown on browser startup. It imports `loadKeybindings` directly (not through the content script's cache) because it has its own lifecycle.

---

## Popup — popup.ts

The toolbar button popup. 94 lines. Shows the harpoon list with add/remove/jump actions.

```typescript
function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
```

Uses the DOM-based `escapeHtml` (not the string-based version from helpers.ts). This is fine for the popup because:
1. The popup renders once (no rapid keystroke re-rendering)
2. The list is small (max 4 items)
3. The popup has its own HTML page with its own DOM, so element creation is cheap

### Why a separate escapeHtml?

The popup is built from a different esbuild entry point. It could import from `../lib/helpers.ts` (and esbuild would bundle it), but the popup is so simple that a local definition avoids the import. This is a pragmatic choice, not a best practice — in a larger project, you'd always import from the shared module.

---

## Options Page — options.ts

The keybinding editor. 207 lines. Renders a table of all bindings grouped by scope, with change/reset buttons and real-time keyboard capture.

### Recording mode

```typescript
interface RecordingState {
  scope: BindingScope;
  action: string;
  row: HTMLElement;
}

let recordingState: RecordingState | null = null;
```

When the user clicks "change" on a binding:
1. Enter recording mode — the button text changes to "cancel", the key display shows "Press a key..."
2. A global `keydown` listener (capture phase) waits for the next keypress
3. The keypress is converted to a string (`keyEventToString(e)`)
4. Collision detection runs (`checkCollision()`)
5. If no collision, the binding is saved
6. Recording mode exits, UI re-renders

### Status bar

```typescript
function showStatus(message: string, type: "success" | "error"): void {
  statusBar.textContent = message;
  statusBar.className = `status-bar visible ${type}`;
  statusTimeout = setTimeout(() => statusBar.classList.remove("visible"), 3500);
}
```

Temporary status messages at the bottom of the settings panel. "success" shows in green, "error" in red. Auto-hides after 3.5 seconds.

### Full reset

```typescript
resetAllBtn.addEventListener("click", async () => {
  config = JSON.parse(JSON.stringify(DEFAULT_KEYBINDINGS));
  await saveKeybindings(config);
  // Update radio buttons
  // Update status
  renderBindings();
});
```

Deep-clones the defaults, saves to storage, re-renders everything. The `storage.onChanged` listener in all content scripts will invalidate their caches automatically.

---

## CSS Architecture

### Shadow DOM scoping

Each panel's styles live inside the Shadow DOM. They cannot leak to the page, and page styles cannot affect them. This means:
- We use simple class names (`.ht-backdrop`, `.ht-titlebar`) without BEM or CSS modules
- No need for CSS specificity wars with the host page
- `:host` targets the shadow host element itself

### macOS Terminal.app aesthetic

All panels follow a consistent design language:
- **Titlebar**: `#3a3a3c` background, red traffic light dot (close button), centered title text, vim badge
- **Body**: `#1e1e1e` background
- **Footer**: `#252525` background with hint text
- **Accent color**: `#0a84ff` (macOS system blue)
- **Font stack**: `'SF Mono', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace`

### Responsive sizing

```css
/* Telescope */
.ht-telescope-container {
  width: 80vw; max-width: 960px;
  height: 70vh; max-height: 640px; min-height: 280px;
}

/* Harpoon */
.ht-harpoon-container { width: 380px; max-width: 90vw; }
.ht-harpoon-list { max-height: min(340px, 50vh); }

/* Frecency */
.ht-frecency-container { width: 480px; max-width: 90vw; max-height: 520px; }
```

Each panel uses fixed width with viewport-relative maximum. `max-width: 90vw` prevents overflow on narrow screens. Telescope is the largest (80vw × 70vh for the two-pane layout). Harpoon is the smallest (380px, it's just a list).

### Custom scrollbar

```css
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
```

Thin, semi-transparent scrollbars matching the dark theme. `-webkit-scrollbar` is Chrome/Safari-specific but works in all Chromium browsers. Firefox uses its own scrollbar styling (which we don't override — Firefox's thin scrollbar looks acceptable by default).

---

## Cross-Browser Compatibility

### webextension-polyfill

Chrome uses `chrome.*` APIs with callbacks. Firefox uses `browser.*` APIs with Promises.

```typescript
import browser from "webextension-polyfill";
const tabs = await browser.tabs.query({active: true}); // Works everywhere
```

The polyfill detects the runtime environment and wraps Chrome's callbacks to return Promises. It's bundled by esbuild into each output file, adding ~20KB per file (before minification).

### Chrome's 4-command limit

Chrome MV3 allows only 4 entries in `manifest.commands`. Our MV3 manifest registers 3: `open-harpoon`, `harpoon-add`, `open-telescope-current`. Everything else (slot jumps 1-4, cycling, frecency, bookmarks, history, vim toggle) is handled by the content script's `keydown` listener.

On Firefox (all 8+ commands registered), `browser.commands.onCommand` intercepts the key event before it reaches the page's DOM. The content script's `keydown` handler never sees these keys. No double-firing.

### CSS caret differences

```css
.ht-telescope-input {
  caret-color: #ffffff;   /* works everywhere */
  caret-shape: block;     /* Firefox-only */
}
```

`caret-shape: block` is a Firefox CSS property that renders a block cursor instead of a line cursor. Chrome silently ignores it. This is progressive enhancement — use the feature where available, degrade gracefully elsewhere.

---

## Performance Patterns

### Summary of optimizations

| Pattern | Where Used | Benefit |
|---------|-----------|---------|
| rAF throttle | Preview updates, frecency render | Coalesces rapid updates to one per frame |
| Synchronous first render | Frecency | Eliminates initial empty flash |
| DocumentFragment | Frecency list | Single DOM operation instead of incremental |
| Class swap (not rebuild) | Active highlight in all panels | O(1) vs O(n) DOM work |
| Direct DOM reference | `activeItemEl` in telescope/frecency | Avoids querySelector on every keypress |
| Boolean panel state | `panelOpen` in telescope | Avoids getElementById on every keypress |
| Virtual scrolling | Telescope results | Renders ~25 items instead of 200+ |
| Element pool | Telescope result items | Reuses DOM elements instead of creating/destroying |
| Passive scroll listener | Telescope | Browser can scroll without waiting for JS |
| Pre-lowercasing | Line cache | Avoids per-search string allocation |
| Line cache + MutationObserver | Grep | DOM walked once, re-filtered from cache |
| Early exit (3x max results) | Grep scoring | Stops scanning after enough candidates |
| Debounced storage saves | Tab onUpdated | Coalesces rapid SPA URL changes |
| Debounced cache invalidation | MutationObserver | 500ms debounce on DOM mutations |
| `will-change` for GPU | Backdrop blur | Hardware-accelerated compositing |
| String-based escapeHtml | helpers.ts | Avoids DOM allocation per call |
| WeakRef for DOM nodes | TaggedLine.nodeRef | Allows GC of detached nodes |
| Virtual scrolling | Bookmark/history results | Renders ~25 items instead of full bookmark/history list |
| Element pool | Bookmark/history result items | Reuses DOM elements across scroll and filter updates |
| Tree cursor CSS swap | Bookmark/history tree views | O(1) cursor movement without tree re-render |
| rAF detail throttle | Bookmark/history detail pane | Coalesces rapid selection changes to one detail update per frame |

---

## State Management

### In-Memory + Storage pattern

All persistent state follows this flow:

```
browser.storage.local.get() → in-memory variable → mutate → browser.storage.local.set()
```

No Redux, no state machines, no pub/sub. The state is small (4 harpoon entries, 50 frecency entries, 4 sessions, 1 config object) and mutations are infrequent (user actions, not continuous streams).

### Storage keys

| Key | Type | Module |
|-----|------|--------|
| `"harpoonList"` | `HarpoonEntry[]` | background.ts |
| `"harpoonSessions"` | `HarpoonSession[]` (max 4) | sessions.ts |
| `"frecencyData"` | `FrecencyEntry[]` (max 50) | frecency.ts |
| `"keybindings"` | `KeybindingsConfig` | keybindings.ts |

### Cross-context sync via storage.onChanged

```typescript
browser.storage.onChanged.addListener((changes) => {
  if (changes.keybindings) cachedConfig = null;
});
```

`storage.onChanged` fires in ALL extension contexts (background, every content script, popup, options) when ANY context writes to storage. This is a free cross-context event bus. When the options page saves keybindings, all tabs' content scripts invalidate their caches.

### WeakRef for DOM references

```typescript
interface TaggedLine {
  nodeRef?: WeakRef<Node>;
}
```

Grep results store weak references to source DOM nodes. If the page removes a node (e.g., SPA navigation), the `WeakRef` allows the garbage collector to reclaim it. Without `WeakRef`, the grep cache would keep detached DOM nodes alive, leaking memory.

On scroll-to-text, `.deref()` checks if the node still exists. If it was GC'd, the slow path (full DOM walk) is used.

---

## Event Handling Patterns

### Capture-phase keyboard handlers

```typescript
document.addEventListener("keydown", keyHandler, true);
```

The `true` (third argument) means capture phase — fires before the page's own handlers (which use bubble phase). This ensures the panel intercepts keys before the page. `e.stopPropagation()` then prevents the event from reaching the page.

Without capture phase, the page's handlers (e.g., Gmail's keyboard shortcuts) would fire before ours, potentially consuming the event.

### Event delegation with closest()

```typescript
resultsList.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest(".ht-result-item");
  if (!item) return;
  setActiveIndex(Number(item.dataset.index));
});
```

One listener on the container instead of one per item. Works with virtual scrolling (items are recycled) and doesn't need re-binding after DOM updates.

### mousedown preventDefault on backdrop

```typescript
backdrop.addEventListener("mousedown", (e) => e.preventDefault());
```

Prevents the mousedown from shifting focus to elements behind the overlay. The `click` event (which fires after mousedown + mouseup) still works for closing the panel.

### wheel preventDefault on preview

```typescript
previewPane.addEventListener("wheel", (e) => {
  e.preventDefault();
  previewContent.scrollTop += e.deltaY;
});
```

Without this, scrolling the preview pane would also scroll the page behind the overlay (event bubbles up). Manual scroll control on `previewContent` instead.

---

## DOM Rendering Strategies

The project uses four rendering strategies, each chosen for its context:

### 1. innerHTML rebuild (Harpoon)

```typescript
container.innerHTML = html;
```

Destroys and recreates all children. Fine because:
- Max 4 items
- No input elements to preserve
- Renders only on explicit user action

### 2. Static shell + dynamic list (Frecency)

```typescript
const input = document.createElement("input"); // built once
const listEl = document.createElement("div");   // contents rebuilt
```

Input survives across renders. List is rebuilt via DocumentFragment. Used because frecency has a search input that must persist across re-renders.

### 3. Class swap (Active highlight)

```typescript
oldItem.classList.remove("active");
newItem.classList.add("active");
```

Zero DOM creation/destruction. Used for arrow key navigation in all panels.

### 4. Virtual scrolling + pool (Telescope)

```typescript
const poolItem = getPoolItem(i); // reuse or create
bindPoolItem(poolItem, resultIdx); // update content
```

Fixed pool of ~25 elements, re-bound to different data on scroll. Most complex but necessary for 200+ results.

### The spectrum

```
Simple ←————————→ Complex
innerHTML → Fragment → Class swap → Virtual scroll
(Harpoon)   (Frecency) (Highlight)  (Telescope)
```

Always choose the simplest approach that meets performance needs.

---

## Tree Navigation Pattern

Both the bookmark and history overlays implement a tree view in the detail pane. The pattern is identical in structure, differing only in what serves as the top-level nodes (folders vs time buckets) and the entry data types. This section documents the shared architecture.

### Flat visible items array

The tree is not rendered from a recursive data structure. Instead, it's flattened into a single array:

```typescript
let treeVisibleItems: { type: "folder" | "entry"; id: string }[] = [];  // bookmarks
let treeVisibleItems: { type: "bucket" | "entry"; id: string }[] = [];  // history
```

This array is rebuilt on every `renderTreeView()` call. It represents exactly the rows currently visible in the tree (collapsed children are excluded). Its indices correspond 1:1 to `data-tree-idx` attributes on DOM elements.

**Why flat?** Cursor navigation becomes trivial — increment or decrement an index into a flat array. No need to traverse a tree structure to find the "next visible node."

### Collapsed state

```typescript
let treeCollapsed = new Set<string>();
```

A set of IDs (folder IDs for bookmarks, bucket label strings for history). When a node's ID is in this set, its children are not emitted to `treeVisibleItems` during `renderTreeView()`.

**Reset on re-entry:** When toggling tree off and back on (`Escape`/`t` → `t`), `treeCollapsed` is cleared. All nodes start expanded. This is a deliberate UX choice — collapsed state is ephemeral.

### Cursor movement — CSS swap without re-render

```typescript
function moveTreeCursor(delta: number): void {
  const newIdx = Math.max(0, Math.min(treeCursorIndex + delta, treeVisibleItems.length - 1));
  if (newIdx === treeCursorIndex) return;
  const oldEl = detailContent.querySelector(`[data-tree-idx="${treeCursorIndex}"]`);
  const newEl = detailContent.querySelector(`[data-tree-idx="${newIdx}"]`);
  if (oldEl) oldEl.classList.remove("tree-cursor");
  if (newEl) {
    newEl.classList.add("tree-cursor");
    newEl.scrollIntoView({ block: "nearest" });
  }
  treeCursorIndex = newIdx;
}
```

This is the key performance optimization: j/k navigation only swaps CSS classes on two elements. No `innerHTML`, no `renderTreeView()`, no `treeVisibleItems` rebuild. The DOM stays intact.

### Collapse/expand — full re-render

```typescript
function toggleTreeCollapse(id: string): void {
  if (treeCollapsed.has(id)) treeCollapsed.delete(id);
  else treeCollapsed.add(id);
  renderTreeView();
}
```

Toggling collapse changes the visible items list (children appear/disappear), so a full re-render is required. `renderTreeView()` rebuilds `treeVisibleItems`, regenerates HTML, and re-applies the cursor.

### `renderTreeView()` — building HTML from flat iteration

The render function iterates over the top-level nodes (folders or buckets), and for each:

1. Pushes `{ type: "folder"/"bucket", id }` to `treeVisibleItems`
2. Emits an HTML div with: collapse arrow (`▶` if collapsed, `▼` if expanded), icon, title, child count
3. If the node is NOT in `treeCollapsed`:
   - For each child entry: pushes `{ type: "entry", id }` to `treeVisibleItems`
   - Emits an HTML div with: icon, title, domain

The `data-tree-idx` attribute on each div matches the index in `treeVisibleItems`, enabling direct element lookup during cursor movement.

### Open confirmation as tree sub-state

Both overlays implement the same pattern:

```typescript
let pendingTreeOpenEntry: EntryType | null = null;
```

When the user presses `Enter` on an entry (or double-clicks), `pendingTreeOpenEntry` is set. The keyboard handler checks this **first** in the tree-mode block, creating a priority sub-state:

```typescript
if (pendingTreeOpenEntry) {
  if (key === "y" || key === "Enter") { open(pendingTreeOpenEntry); return; }
  if (key === "n" || key === "Escape") { pendingTreeOpenEntry = null; renderTreeView(); return; }
  return; // swallow all other keys
}
// Normal tree navigation...
```

The confirmation dialog replaces the detail content with the entry title and a y/n hint. The footer also updates to show confirmation-specific hints.

### Click handler — preserving DOM for dblclick

The tree click handler distinguishes three cases:

1. **Click on folder/bucket**: calls `toggleTreeCollapse()` (full re-render). Safe because folders don't have a dblclick action.
2. **Click on entry**: CSS-only cursor swap. Crucially, this does NOT call `renderTreeView()`, preserving the DOM elements so a dblclick event can fire on the same target.
3. **Dblclick on entry**: sets `pendingTreeOpenEntry`, shows open confirmation.

If single-click on an entry triggered a re-render (rebuilding `innerHTML`), the DOM element would be destroyed between the first and second click. The browser would not fire `dblclick` because the original target element no longer exists.

This is a general principle: **any click handler that coexists with dblclick on the same element must avoid DOM replacement.**

### `data-tree-idx` attribute indexing

Every tree node div has `data-tree-idx="${index}"` where `index` matches its position in `treeVisibleItems`. This enables:
- `moveTreeCursor()` to find elements by index without iterating children
- Click handlers to look up `treeVisibleItems[idx]` for type checking (`"folder"` vs `"entry"`)
- Initial cursor placement to find the element matching the currently-selected left-pane item

### Dynamic footer updates

The footer changes for three states within tree mode:
1. **Normal navigation**: `j/k nav | Enter fold/open | Esc / t back`
2. **Open confirmation**: `y / Enter confirm | n / Esc cancel`

The footer is rebuilt by `updateFooter()` which checks both `detailMode` and `pendingTreeOpenEntry` to determine the correct hint text.

---

## Debugging Lessons

### The Frecency Input Destruction Bug

**Symptom**: Typing in the frecency filter broke after the first character.

**Root cause**: `render()` used `container.innerHTML = html`, which rebuilt the entire panel including the input element. After the first keystroke triggered `render()`, the input was destroyed and replaced. The cursor disappeared.

**Fix**: Build the input once outside the render cycle. Only update `listEl.textContent`.

**Lesson**: Never rebuild a parent element that contains a focused input. Separate static shell from dynamic content.

### The Frecency Flicker Bug

**Symptom**: Arrow key navigation caused visible flicker.

**Root cause**: `renderList()` was called on every arrow key, clearing and rebuilding all items. Even with DocumentFragment, the clear-then-append cycle caused one frame with no visible items.

**Fix**: Separate `updateActiveHighlight()` (class swap) from `renderList()` (full rebuild). Arrow keys only call `updateActiveHighlight()`.

**Lesson**: Distinguish "data changed" (rebuild) from "selection changed" (class swap).

### The CSS Transition Shadow Glitch

**Symptom**: Frecency items had ghosting during rapid arrow navigation.

**Root cause**: `transition: background 0.1s` meant background color animated between active (blue) and inactive (transparent). During rapid class swaps, multiple items were mid-transition, creating visual artifacts.

**Fix**: Remove the transition. Class swaps should be instant.

**Lesson**: CSS transitions on rapidly-toggled classes cause artifacts. Only use transitions on hover or deliberate animations.

### The Content Script Injection Guard Bug

**Symptom**: After extension reload, the new content script didn't inject.

**Root cause**: `if (window.__harpoonTelescopeInjected) return;` prevented new code from loading.

**Fix**: Cleanup function approach — new injection calls old cleanup first.

**Lesson**: Guard patterns should allow replacement, not just prevent duplication.

### Firefox Content Script Caching

**Symptom**: Code changes didn't take effect after extension reload.

**Root cause**: Firefox caches content scripts in memory even after extension reload.

**Fix**: Full extension removal + re-install, or the cleanup function approach.

**Lesson**: During Firefox development, sometimes you need full remove + re-add, not just reload.

---

## Patterns Worth Reusing

### 1. Message Router

A single `switch` on `m.type` routing to handler functions. Simple, debuggable, extensible. Works for any IPC or event-driven architecture.

### 2. Lazy-Load Guard

`ensureLoaded()` with a boolean flag. Safe to call multiple times. Essential for service workers or any context that can restart.

### 3. Cache + Observer Invalidation

Cache expensive operations. Use MutationObserver (or events) to invalidate. Debounce invalidation.

### 4. Configurable Keybindings with Per-Scope Collision Detection

Store bindings as data. Match at runtime. Detect conflicts within the active scope.

### 5. Additive Mode Aliases

Don't replace bindings — add alternatives. Basic keys always work. Advanced mode layers extras on top.

### 6. Shadow DOM for Page-Injected UI

Prevents style leakage both ways. Required for any extension injecting UI into arbitrary pages.

### 7. DocumentFragment Batching

Build off-DOM, append in one operation. Eliminates flash-of-empty.

### 8. Direct DOM Reference

Keep a variable pointing to the active element. Update on change. Avoids repeated querySelector.

### 9. rAF Throttle + Synchronous First Render

Defer subsequent renders to animation frames. Render first frame synchronously.

### 10. Event Delegation with closest()

One listener on a container. `closest()` finds the target. Works with dynamic/pooled elements.

### 11. WeakRef for Optional DOM References

Don't prevent garbage collection of nodes you don't own. Check with `.deref()`.

### 12. Cleanup Function on Window

For content scripts: store cleanup, call before re-init. Handles extension reloads.

### 13. storage.onChanged as Cross-Context Bus

Writing to `browser.storage.local` notifies all contexts automatically.

### 14. Progressive CSS Enhancement

Use browser-specific features (`caret-shape: block`). Accept graceful degradation.

### 15. Virtual Scrolling with Element Pool

Fixed-height items, sentinel for scrollbar, pool of reusable elements. Passive scroll listener.

### 16. Forward-Compatible Config Merging

Start from defaults, overlay stored values. New features get defaults; user customizations survive.

### 17. Dependency Injection via Interface

Pass state accessor objects (like `HarpoonState`) instead of importing globals. Enables testing and prevents circular deps.

### 18. Debounced Storage Writes

Coalesce rapid mutations (SPA URL changes, typing) into single storage writes.

### 19. Tree Navigation with Flat Visible Items

Flatten a hierarchical tree into a `treeVisibleItems` array. Cursor is an index into this array. Collapse/expand rebuilds the array; cursor movement just swaps CSS classes. Applicable to any tree UI (file explorers, nested menus, org charts).

### 20. Open Confirmation Sub-state

Nest a confirmation dialog inside an existing mode by setting a pending entry variable. Check it first in the keyboard handler. Avoids adding a new top-level mode for a transient interaction.

### 21. Dblclick-Safe Click Handlers

When single-click and dblclick coexist on the same element, the single-click handler must not replace DOM (via `innerHTML` or full re-render). Use CSS class manipulation instead. The browser only fires `dblclick` if both clicks hit the same DOM element.

### 22. Multi-Step Wizard State Machine

Chain steps (`chooseType → chooseDest → nameInput`) with `Escape` going back one step. Share navigation logic between steps with identical key handling. Only create step-specific blocks for steps with unique input (like a text field).
