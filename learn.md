# Harpoon Telescope — Complete Implementation Guide

This file exists so I can grow from junior -> mid -> senior by mastering how this codebase actually works. It is a full rebuildable walkthrough, not a tutorial. It is meant to make me confident explaining every subsystem in an interview, because this product is mine and I can defend every tradeoff.

What I want to get out of this:

- I can trace data from user input to UI output to storage and back.
- I can explain browser primitives and why the architecture looks like this.
- I can extend or refactor the code without fear because I understand the flow.
- I can transfer these patterns to any other project (framework or no framework).
- I build critical thinking and problem-solving skill by reasoning about tradeoffs.

How I use this guide:

1. Trace one flow end-to-end for a feature.
2. Open the exact files mentioned and follow the flow in code.
3. Re-implement or modify a small part without looking.
4. Explain the system out loud as if I am teaching it.
5. Ask: why this approach, what tradeoff, what failure mode?
6. Capture one reusable engineering pattern in my own words.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Data-Flow Walkthrough (Start -> End -> Start)](#data-flow-walkthrough-start---end---start)
3. [Folder Structure](#folder-structure)
4. [Build System — esBuildConfig/build.mjs](#build-system--esbuildconfigbuildmjs)
5. [Manifests — MV2 and MV3](#manifests--mv2-and-mv3)
6. [Shared Types — src/types.d.ts](#shared-types--srctypesdts)
7. [Keybinding System — src/lib/shared/keybindings.ts](#keybinding-system--srclibsharedkeybindingsts)
8. [Content Script Boot — src/entrypoints/content-script](#content-script-boot--srcentrypointscontent-script)
9. [Background Process — src/entrypoints/background](#background-process--srcentrypointsbackground)
10. [Search Current Page — src/lib/searchCurrentPage](#search-current-page--srclibsearchcurrentpage)
11. [Search Open Tabs — src/lib/searchOpenTabs](#search-open-tabs--srclibsearchopentabs)
12. [Tab Manager — src/lib/tabManager](#tab-manager--srclibtabmanager)
13. [Bookmarks — src/lib/bookmarks](#bookmarks--srclibbookmarks)
14. [History — src/lib/history](#history--srclibhistory)
15. [Help — src/lib/help](#help--srclibhelp)
16. [Shared Utilities — src/lib/shared](#shared-utilities--srclibshared)
17. [Panel Lifecycle + Guards](#panel-lifecycle--guards)
18. [Performance Patterns](#performance-patterns)
19. [UI Conventions (Footers, Vim, Filters)](#ui-conventions-footers-vim-filters)
20. [Patterns Worth Reusing](#patterns-worth-reusing)

---

## Project Overview

Harpoon Telescope is a keyboard-first browser extension inspired by Neovim plugins:

- Tab Manager (Harpoon): pin up to 4 tabs with scroll restore and sessions.
- Search Current Page (Telescope): fuzzy grep with structural filters + preview.
- Search Open Tabs (Frecency): ranked open tabs by frequency and recency.
- Bookmarks + History: two-pane browsers with tree views and confirmations.

Everything runs in plain TypeScript with no UI framework. Overlays are Shadow DOM panels injected into the active page.
Engineering promise: stay browser-primitive (DOM/Shadow DOM/WebExtension APIs), keep UI latency low, minimize visual glitching, and preserve Firefox/Chrome parity.

---

## Data-Flow Walkthrough (Start -> End -> Start)

This section is the heart of the file. It shows how data moves through the system so I can rebuild it from memory. Each flow is a lesson in architecture, state management, algorithms, and critical thinking.

How to naturally walk these chapters:

1. Read one flow from trigger to side effect.
2. Extract the core concepts from that flow.
3. Identify the exact algorithmic steps used.
4. Practice one extension/change for that flow.
5. Explain the flow out loud in interview style.

---

### Flow A — Open a Panel and Search

User presses `Alt+F` on any page. The content script's global keydown handler in `src/lib/appInit/appInit.ts` catches the event, and `matchesAction(e, config, "global", "searchInPage")` returns true. The handler calls `openSearchCurrentPage(config)` from `src/lib/searchCurrentPage/searchCurrentPage.ts`, which creates a Shadow DOM host (`#ht-panel-host`) and builds the search UI inside it.

The content script owns DOM access because the background cannot touch page DOM — this is a fundamental browser security boundary. The panel guard (`if (document.getElementById("ht-panel-host")) return;`) prevents global shortcuts from fighting overlay controls; without it, pressing `Alt+F` while the panel is open would try to open another panel.

When the user types a query, the `input` event fires and updates the closure-scoped state — `currentQuery` holds what the user typed, `activeFilters` holds structural filters like `/code` or `/headings`. Then `applyFilter()` runs `grepPage()` from `src/lib/searchCurrentPage/grep.ts`, which populates `results`. Finally `renderResults()` updates the DOM and `updatePreview()` shows context for the highlighted item.

This is unidirectional data flow: events mutate state, state drives render, render never mutates state. The pattern prevents bugs where UI and state diverge.

The challenge is performance. The DOM can have thousands of nodes, and scanning all of them on every keystroke would freeze the UI. All JavaScript runs on a single thread — the main thread — with no parallelism. The event loop processes one event at a time: keydown fires, the handler runs synchronously, render functions update DOM synchronously, then the browser paints. If any step takes longer than ~16ms (the budget for 60fps), the UI janks.

The solution uses several techniques. First, `grepPage()` walks the DOM once and caches the lines, invalidating on mutations with a 500ms debounce. This means stale results for up to 500ms after DOM changes, but no repeated full-DOM walks — O(n) once instead of O(n) per keystroke. Second, fuzzy scoring uses a character-by-character algorithm that iterates once per query character, avoiding regex catastrophic backtracking. Third, even if 10,000 lines match, `MAX_RESULTS` caps the list at 200, bounding rendering work. Fourth, virtual scrolling keeps only ~25 DOM nodes in the results list, recycling them as the user scrolls — O(visible) rendering instead of O(total). Fifth, expensive fields like `domContext`, `ancestorHeading`, and `href` are computed lazily in `updatePreview()`, not upfront for all 200 results.

When the user navigates with arrows (or j/k in vim mode), `activeIndex` changes, `renderResults()` highlights the new item, and `updatePreview()` shows its context. When the user presses Enter, the overlay scrolls to the target element using `src/lib/shared/scroll.ts` and closes.

The lesson here is a checklist for search UI performance: Am I re-scanning data on every keystroke? Cache it. Am I rendering all results? Virtual scroll. Am I doing expensive work upfront? Lazy compute. Am I using regex? Watch for backtracking.

Concepts to internalize from this flow:

1. **Pipeline thinking:** input event -> query parse -> ranked filtering -> render -> side effect.
2. **Separation of concerns:** search algorithm is in `grep.ts`, UI orchestration in `searchCurrentPage.ts`.
3. **Performance budget mindset:** optimize for keystroke latency first, not theoretical elegance.

Algorithm lens (step-by-step):

1. Normalize query.
2. Reuse cached candidate lines.
3. Score candidates (fuzzy, term-based).
4. Sort and cap results.
5. Render only visible rows.
6. Compute rich preview lazily for active item.

Extension path (how to safely add capability):

1. Add new filter token mapping in `searchCurrentPage.ts`.
2. Add corresponding collector branch in `grep.ts`.
3. Ensure filter parsing + pills + title badges stay in sync.
4. Verify result ranking remains deterministic.

Interview articulation:

1. "I optimized search by caching DOM extraction and virtualizing rendering."
2. "I kept algorithm and UI layers separate so changes stay low-risk."
3. "I used lazy enrichment to avoid upfront cost on non-active rows."

**Files to trace:** `src/lib/appInit/appInit.ts` (global key handler), `src/lib/searchCurrentPage/searchCurrentPage.ts` (overlay UI + state), `src/lib/searchCurrentPage/grep.ts` (DOM walking + fuzzy scoring), `src/lib/shared/scroll.ts` (scroll-to-text).

---

### Flow B — Tab Manager Add + Jump

User presses `Alt+Shift+T` to add the current tab. The content script in `src/lib/appInit/appInit.ts` catches the keybind and sends `{ type: "TAB_MANAGER_ADD" }` to the background. Only the background has `browser.tabs.*` API access — content scripts are sandboxed and cannot manipulate browser tabs directly. This is the browser's security model.

The background in `src/entrypoints/background/background.ts` first calls `ensureTabManagerLoaded()` to load state from storage if needed. MV3 service workers can be killed at any time, so every function that touches state calls this guard first — it's idempotent, safe to call multiple times. Then the background sends `GET_SCROLL` back to the content script to capture the current scroll position, because scroll state is page-owned and the background cannot read `window.scrollX` directly. With scroll position in hand, the background creates a `TabManagerEntry`, compacts slots to keep them sequential (1, 2, 3 instead of 1, 3, 4), saves to `browser.storage.local`, and returns. The content script shows a feedback toast via `src/lib/shared/feedback.ts` saying "Added to Tab Manager [slot]".

Later, the user presses `Alt+1` to jump. The content script sends `{ type: "TAB_MANAGER_JUMP", slot: 1 }`. The background finds the entry and either activates the existing tab or, if it was closed, re-opens the URL in a new tab and restores scroll.

The core challenge is that tab IDs are ephemeral — when the browser restarts, all tab IDs change. If we stored tab IDs naively, the list would become useless after restart. The solution is to store URL + scroll position alongside the tab ID. When jumping to a "closed" entry, we re-open the URL in a new tab and restore scroll. The tradeoff: the re-opened tab is a fresh page load, not the original session state with form inputs and history.

To keep the list accurate, the background reconciles on every list access. Before returning the tab manager list, it queries all open tabs and marks entries as `closed` if their tab ID no longer exists. This is O(n) where n = tab count, but n is typically under 100 so it's fast.

The background owns canonical state. The overlay is just a view of that state — content scripts have no persistent state and request fresh data on every panel open. This split exists because the background persists across tab closes while content scripts die with their tab, storage is more accessible from the background, and centralizing state avoids sync bugs where multiple copies diverge.

Message passing is async. The content script sends a message and awaits the response: `const result = await browser.runtime.sendMessage({ type: "TAB_MANAGER_ADD" })`. Under the hood, the content script posts to an IPC channel and yields while the background processes. This is cooperative multitasking — no threads, no locks, no race conditions from parallelism. But there are still ordering questions: what if two tabs send `TAB_MANAGER_ADD` at the same time? The background processes them sequentially via the event loop, so the second add sees the first's result. No conflicts.

The lesson for cross-context communication: identify which context owns the state, make the owner's operations idempotent where possible, use guards like `ensureLoaded` to handle process restarts, and treat messages as requests rather than commands — the owner decides what to do.

Concepts to internalize from this flow:

1. **Context ownership:** content script cannot own browser tab state; background must.
2. **Canonical state:** background is source of truth; overlays are views.
3. **Eventual consistency:** reconcile tab IDs against real open tabs on access.

Algorithm lens (step-by-step):

1. Receive `TAB_MANAGER_ADD`.
2. Ensure list loaded + reconciled.
3. Read current scroll via content script message.
4. Insert/compact/save entry.
5. On jump, switch or recreate tab and restore scroll.

Extension path (how to safely add capability):

1. Add new tab-manager message type in background switch.
2. Wire keybind/action in `appInit.ts`.
3. Update panel behavior in `tabManager.ts`.
4. Preserve slot compaction and closed-entry semantics.

Interview articulation:

1. "I designed around unstable tab IDs by storing URL + scroll and recovering state."
2. "I used explicit message contracts to separate page and browser responsibilities."
3. "I guarded state access for MV3 worker restarts."

**Files to trace:** `src/lib/appInit/appInit.ts` (keybind handler), `src/entrypoints/background/background.ts` (state + message handling), `src/lib/shared/feedback.ts` (toast).

---

### Flow C — Bookmarks / History

User presses `Alt+B` to open Bookmarks. The content script opens the overlay from `src/lib/bookmarks/bookmarks.ts` and immediately sends `{ type: "BOOKMARK_LIST" }` to the background. The background calls `browser.bookmarks.getTree()` — an API only available in the background context — and returns flattened entries. Until that Promise resolves, the overlay shows nothing or a loading state. Once data arrives, it's stored in `allEntries` and rendered synchronously. No partial updates, no flickering.

The overlay is a pure view layer with its own local state for navigation and filtering. It does not cache the bookmark tree long-term — it requests fresh data on every open, keeping things simple and avoiding stale-data bugs.

The challenge is providing fast filtering over a potentially large dataset (thousands of bookmarks) while keeping the tree context visible so users know where things are. The solution uses a two-pane layout: the left pane shows filtered results, the right pane shows the folder tree. Users can switch focus with Tab or T. This adds UI complexity, but users always see their location in the hierarchy.

The overlay manages multiple focus targets through a `detailMode` state machine. In `"tree"` mode, the tree is visible but results have focus. In `"treeNav"` mode, the tree has a cursor and results are dimmed. When the user presses `d` to delete, `detailMode` becomes `"confirmDelete"` and a confirm prompt appears. Pressing `y` confirms, sends `{ type: "BOOKMARK_REMOVE", id }` to the background, and refreshes the list. Pressing `n` or Escape cancels back to tree mode. Each state defines what the UI looks like and which keys do what — there's no magic, every transition is explicit in the key handler.

Filtering combines substring and fuzzy matching, then ranks by match quality (exact -> starts-with -> substring -> fuzzy). With no filter pill active, matching runs across title/url/folder path and sorts with title-first tie-breaks. With `/folder` active, matching is scoped to folder path.

The lesson for two-pane UIs with multiple focus targets: use a state machine to make behavior explicit, define all transitions upfront to avoid impossible state combinations, and keep rendering functions pure — state in, DOM out.

Concepts to internalize from this flow:

1. **State machine discipline:** `detailMode` controls key meaning and render output.
2. **Relevance design:** ranking strategy matters as much as query matching.
3. **Context-preserving UI:** tree pane keeps location awareness during filtering.

Algorithm lens (step-by-step):

1. Load data from background API wrappers.
2. Parse slash filters and free-text query.
3. Combine substring + fuzzy hit detection.
4. Rank by field priority/tie-breakers.
5. Render virtualized list + synchronized detail/tree states.

Extension path (how to safely add capability):

1. Add new filter token and parser branch.
2. Define ranking policy for new field.
3. Add mode transition rules in keyboard handler.
4. Update footer hints and confirm states consistently.

Interview articulation:

1. "I treated keyboard behavior as a formal state machine to avoid ambiguous UX."
2. "I prioritized user orientation by keeping tree context visible."
3. "I balanced precision and recall with ranked substring+fuzzy matching."

**Files to trace:** `src/lib/bookmarks/bookmarks.ts` (overlay UI + state), `src/entrypoints/background/background.ts` (API wrappers).

---

### Flow D — Session Restore on Startup

User closes the browser with tabs pinned in Tab Manager. When the browser reopens, `browser.runtime.onStartup` fires in the background process at `src/entrypoints/background/background.ts`. Tab IDs are not stable across browser restarts — the old `tabManagerList` is useless because all those tab IDs now point to nothing. The background clears the stale list and loads `tabManagerSessions` from storage to prepare for restore.

The challenge is timing. Content scripts load asynchronously, and at startup the background is ready before any tab's content script has finished initializing. If the background immediately tries to send `SHOW_SESSION_RESTORE` to the active tab, the message fails because no listener exists yet.

The solution uses a retry loop with initial delay. The background waits 1.5 seconds after startup before even trying — this gives the browser time to load at least one tab. Then it attempts to send the message. If it fails (content script not ready), it waits 1 second and retries, up to 5 attempts. In the worst case, the restore prompt appears after ~6.5 seconds, but it reliably appears. If all retries fail, the user can still manually open Tab Manager and load a session — the feature degrades gracefully instead of breaking.

Startup is a state transition at the application level, outside any single overlay. The restore prompt is triggered from `browser.runtime.onStartup`, then sent into an active tab via retries until a content script is ready. When the user picks a session in `src/lib/tabManager/session.ts`, the overlay sends `{ type: "SESSION_LOAD", name }`. The background rebuilds `tabManagerList` from the session entries, and the user's pinned tabs are restored.

Startup events are scheduled on the event loop like any other. The call to `setTimeout(tryShowRestore, 1500)` schedules a callback to run later, and the event loop executes it when the timer fires, after any pending events. There's nothing special about startup — it's just another event in the queue.

The lesson for coordinating between contexts with different lifetimes: assume the other context might not be ready, use retries with backoff instead of infinite polling, and always provide a manual fallback so the user isn't stuck.

Concepts to internalize from this flow:

1. **Lifecycle mismatch awareness:** background startup does not imply content readiness.
2. **Race handling strategy:** bounded retries beat brittle single-shot messaging.
3. **Recovery-first design:** clear stale state and offer manual load fallback.

Algorithm lens (step-by-step):

1. On startup, read saved sessions.
2. Reset stale runtime tab-manager entries.
3. Delay prompt attempt.
4. Try send restore prompt message.
5. Retry on failure up to fixed limit.

Extension path (how to safely add capability):

1. Keep startup logic idempotent.
2. Keep retries bounded and logged.
3. Ensure failure path still leaves manual feature path usable.

Interview articulation:

1. "I turned a startup race into eventual consistency with bounded retries."
2. "I separated persistent session data from runtime tab identity."
3. "I designed a graceful fallback instead of hard failure."

**Files to trace:** `src/entrypoints/background/background.ts` (startup handler), `src/lib/tabManager/session.ts` (session restore UI).

---

## Folder Structure

```
harpoon_telescope/
├── esBuildConfig/
│   ├── build.mjs                   # esbuild bundler
│   ├── manifest_v2.json            # Firefox/Zen manifest (MV2)
│   └── manifest_v3.json            # Chrome manifest (MV3)
├── src/
│   ├── types.d.ts                  # Global TS types
│   ├── entrypoints/
│   │   ├── background/
│   │   │   └── background.ts
│   │   ├── content-script/
│   │   │   └── content-script.ts
│   │   ├── toolbar-popup/
│   │   │   ├── toolbar-popup.ts
│   │   │   ├── toolbar-popup.html
│   │   │   └── toolbar-popup.css
│   │   └── options-page/
│   │       ├── options-page.ts
│   │       ├── options-page.html
│   │       └── options-page.css
│   ├── lib/
│   │   ├── appInit/                 # content-script bootstrap
│   │   ├── shared/                  # keybindings, helpers, sessions, scroll, feedback
│   │   ├── tabManager/              # Tab Manager panel + sessions UI
│   │   ├── searchCurrentPage/       # Telescope search (current page)
│   │   ├── searchOpenTabs/          # Frecency open tabs list
│   │   ├── bookmarks/               # Bookmarks browser
│   │   ├── history/                 # History browser
│   │   ├── addBookmark/             # Add bookmark wizard
│   │   └── help/                    # Help overlay
│   └── icons/
│       ├── icon-48.png
│       ├── icon-96.png
│       └── icon-128.png
└── dist/                            # build output
```

---

## Build System — esBuildConfig/build.mjs

The build script bundles four entry points into IIFEs and copies static assets to `dist/`:

- `src/entrypoints/background/background.ts` -> `dist/background.js`
- `src/entrypoints/content-script/content-script.ts` -> `dist/content-script.js`
- `src/entrypoints/toolbar-popup/toolbar-popup.ts` -> `dist/toolbar-popup/toolbar-popup.js`
- `src/entrypoints/options-page/options-page.ts` -> `dist/options-page/options-page.js`

**Why IIFE?**

MV2 background + content scripts do not support ES modules. They run in the global scope. IIFE wraps the code so variables don't leak. This works on both MV2 and MV3.

**Why esbuild?**

It's fast (10-100x faster than webpack) and simple. The build script is ~50 lines, not hundreds.

**CSS as text:**

CSS is loaded as text via esbuild loader (`{ '.css': 'text' }`). This allows injecting styles into Shadow DOM as a `<style>` tag, keeping overlay styles isolated from page CSS.

**Compatibility check:**

`npm run verify:compat` validates MV2/MV3 permissions and ensures MV3 stays within Chrome suggested-command limits.

---

## Manifests — MV2 and MV3

- Firefox/Zen use MV2 (`manifest_v2.json`).
- Chrome uses MV3 (`manifest_v3.json`) with a service worker.

**Why two manifests?**

Chrome moved to MV3; Firefox still supports MV2. MV3 changes background lifecycle semantics (service workers can be suspended), so we keep both manifests for cross-browser compatibility.

**How we handle commands across browsers:**

Most shortcuts go through the content script's `keydown` listener, not `browser.commands`. The manifests keep only core suggested commands (open/add/search) for MV3 compatibility, while the content script handles slot jumps and the full keybinding system (including user-customized bindings and panel-local behavior).

---

## Shared Types — src/types.d.ts

This file defines global types shared across background + content + UI:

- `TabManagerEntry`, `TabManagerSession`
- `GrepResult`, `SearchFilter`
- `BookmarkEntry`, `HistoryEntry`, `FrecencyEntry`

**Why ambient types?**

Ambient types (in `.d.ts`) are globally available without imports. This reduces boilerplate for interfaces used across 10+ files.

**Tradeoff:** No explicit imports means it's harder to trace where a type is defined. Mitigated by having one central `types.d.ts`.

---

## Keybinding System — src/lib/shared/keybindings.ts

Keybinding storage and matching are centralized here:

- Stored in `browser.storage.local` and merged with defaults for forward compatibility.
- Two navigation modes: basic and vim (adds j/k, never replaces).
- Core action matching is centralized (`matchesAction`), and panel-local single-letter controls (like `d/m/t/c`) are handled case-insensitively inside overlay key handlers.

**Why merge with defaults?**

When the extension updates and adds new shortcuts, users with saved keybindings won't have the new keys. `mergeWithDefaults()` overlays saved bindings onto the full default config, so new actions get their defaults.

**Why vim as additive?**

Arrow keys always work. j/k are bonuses when vim mode is on. Users don't need to learn vim to use the extension.

---

## Content Script Boot — src/entrypoints/content-script

Entry point `src/entrypoints/content-script/content-script.ts` is minimal: it calls `initApp()` in `src/lib/appInit/appInit.ts`.

`initApp()` handles:

- cleanup on extension reload (`window.__harpoonTelescopeCleanup`)
- keybinding cache + invalidation
- global key handler (panel open, toggleVim)
- message router (`GREP`, `GET_SCROLL`, `OPEN_*`)

**Why cleanup on reload?**

Firefox caches content scripts. On extension reload, the old script stays alive. Without cleanup, you'd have duplicate event listeners. The cleanup function removes old listeners before setting up new ones.

**Why cache keybindings?**

Every keypress calls `getConfig()`. Without caching, that's an async message round-trip on every keypress — noticeable latency. The cache loads once and invalidates on storage changes.

---

## Background Process — src/entrypoints/background

Background entry `src/entrypoints/background/background.ts` owns:

- tab manager list + scroll restore
- sessions storage and restore prompt
- frecency scoring + eviction
- bookmark usage tracking
- message routing

**Key patterns:**

- **Lazy-load guards:** `ensureTabManagerLoaded()`, `ensureFrecencyLoaded()`, and bookmark/session load helpers. MV3 service workers can restart anytime, so stateful handlers call the relevant guard before read/write.

- **State reconciliation:** Before returning tab manager list, query all open tabs and mark entries as `closed` if their tab ID no longer exists.

- **Retry logic:** For session restore prompt, retry sending to content script until one is ready.

---

## Search Current Page — src/lib/searchCurrentPage

`grep.ts` walks the DOM, builds a cache, and scores results using character-by-character fuzzy scoring.

**Key ideas:**

- Line cache with MutationObserver invalidation (500ms debounce)
- Structural filters (`/code`, `/headings`, `/img`, `/links`) are unioned
- Lazy context enrichment (dom context, heading, href)
- MAX_RESULTS limit (200) for UI stability

`searchCurrentPage.ts` builds the UI: list, preview pane, virtual scrolling, and key handling.

**Complexity analysis:**

- DOM walk: O(n) where n = nodes
- Filter: O(m) where m = cached lines
- Render: O(k) where k = visible items (~25)
- Total per keystroke: O(m) — dominated by filter

---

## Search Open Tabs — src/lib/searchOpenTabs

Uses frecency scores to rank open tabs. Filtering accepts both substring and fuzzy matches, then ranks by match quality (exact -> starts-with -> substring -> fuzzy), preferring title hits first, then tighter title matches, then URL matches.

**What is frecency?**

A Mozilla-coined term: frequency + recency. Tabs visited often and recently rank higher. The formula decays over time so old visits matter less.

---

## Tab Manager — src/lib/tabManager

Manages list UI + sessions UI.

- slots are compacted to 1..N
- closed tabs persist and re-open on jump
- sessions stored in `tabManagerSessions` (max 4)

**Why max 4 slots?**

Opinionated design. More slots = harder to remember which is which. 4 is enough for a focused workflow.

---

## Bookmarks — src/lib/bookmarks

Two-pane UI (results + tree). `detailMode` controls tree focus and confirm states.

- `/folder` filter for folder path
- `m` opens move picker
- `t` focuses tree
- `c` clears search when list is focused

**Why tree-first?**

Context matters. Seeing the folder tree while filtering helps users understand where bookmarks live.

---

## History — src/lib/history

Same two-pane tree-first pattern:

- time-bucketed tree view (Today, Yesterday, This Week, Last Week, This Month, Older)
- filters: `/hour`, `/today`, `/week`, `/month`
- `c` clears search when list is focused

---

## Help — src/lib/help

Help overlay builds sections from live keybinding config. It documents the panel controls and filters.

**Why live keybindings?**

If the user customizes shortcuts, the help menu reflects their actual bindings, not the defaults.

---

## Shared Utilities — src/lib/shared

- `helpers.ts`: `escapeHtml`, `escapeRegex`, `buildFuzzyPattern`, `extractDomain`
- `filterInput.ts`: shared slash-filter parsing used by search/bookmarks/history overlays
- `panelHost.ts`: shadow host, base styles, focus trapping, vim badge
- `scroll.ts`: scroll-to-text highlight
- `feedback.ts`: toast messages
- `sessions.ts`: session CRUD helpers
- `frecencyScoring.ts`: frecency scoring + eviction
- `runtimeMessages.ts`: typed message contracts for background <-> content runtime channels

---

## Panel Lifecycle + Guards

- panels are isolated Shadow DOM trees
- global keybinds are blocked while a panel is open
- `dismissPanel()` tears down the host

**Why block global keybinds when panel is open?**

Prevents conflicts. `Alt+F` opens the panel; once open, pressing `Alt+F` should not try to open another. The panel guard ensures only the panel's key handler responds.

---

## Performance Patterns

- **Virtual lists with DOM pooling:** Only ~25 DOM nodes exist; they're recycled as the user scrolls.
- **rAF throttled updates:** Rendering is scheduled via `requestAnimationFrame` to batch DOM writes.
- **Cached DOM grep + mutation invalidation:** Walk the DOM once, cache lines, invalidate on changes.
- **Lazy computation:** Expensive fields (domContext, ancestorHeading) are computed on-demand, not upfront.

---

## UI Conventions (Footers, Vim, Filters)

- Footer order: nav -> secondary (list/tree) -> action (clear/del/move) -> primary (open) -> close/back
- Footer labels: uppercase key + lowercase label (ex: `D del`)
- Vim mode: j/k only when `navigationMode === "vim"`
- Clear search: only when list/results pane is focused

**Why strict footer order?**

Consistency across panels. Users learn the pattern once and can predict where keybind hints appear.

---

## Patterns Worth Reusing

- **Message routing with `type` discriminators:** Simple, scalable, easy to trace.
- **Lazy-load guards:** Safe for service worker restarts; idempotent.
- **Overlay UI in Shadow DOM:** Isolated styles; no page CSS collisions.
- **State machines (`detailMode`, `focusedPane`):** Explicit state; predictable behavior.
- **Unidirectional data flow:** Events mutate state; render reads state.
- **Ranked text matching:** Combine substring and fuzzy matching, then rank by quality so exact/tighter title hits rise first.
- **Virtual scrolling:** O(visible) rendering for large lists.

---

## Final Thought

If I can trace a feature from keypress to storage to render and back, I understand the system. If I can explain the tradeoffs, I can defend the design. If I can apply these patterns elsewhere, I've grown as an engineer.

This codebase is mine. I built it to learn, and now I can teach it.
