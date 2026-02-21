# Harpoon Telescope — Complete Implementation Guide

This file exists so I can grow from junior -> mid -> senior by mastering how this codebase actually works. It is a full rebuildable walkthrough, not a tutorial. It is meant to make me confident explaining every subsystem in an interview, because this product is mine and I can defend every tradeoff.

## Current Focus (System-Wide)

- Treat the product as one integrated system: search, tab manager, sessions, bookmarks, help, shared runtime contracts, and build/release tooling.
- Current engineering focus is Tab Manager + Session behavior, but only as part of the whole architecture and UX.
- Reliability and performance work should preserve cross-panel consistency, clean data flow, and maintainable module boundaries.
- Store release work (AMO/CWS) follows system-level correctness, not just one feature area.

What I want to get out of this:

- I can trace data from user input to UI output to storage and back.
- I can explain browser primitives and why the architecture looks like this.
- I can extend or refactor the code without fear because I understand the flow.
- I can transfer these patterns to any other project (framework or no framework).
- I build critical thinking and problem-solving skill by reasoning about tradeoffs.
- I can explain algorithmic complexity, failure modes, and why each solution was chosen.
- I can defend vanilla TypeScript architecture decisions against framework alternatives.

How I use this guide:

1. Trace one flow end-to-end for a feature.
2. Open the exact files mentioned and follow the flow in code.
3. Re-implement or modify a small part without looking.
4. Explain the system out loud as if I am teaching it.
5. Ask: why this approach, what tradeoff, what failure mode?
6. Capture one reusable engineering pattern in my own words.
7. Reproduce one real bug path, patch it, verify it, and document the lesson.

This guide is self-contained: no prerequisite docs are required to learn the system end-to-end.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Data-Flow Walkthrough (Start -> End -> Start)](#data-flow-walkthrough-start---end---start)
3. [Folder Structure](#folder-structure)
4. [Build System — esBuildConfig/build.mjs](#build-system--esbuildconfigbuildmjs)
5. [Manifests — MV2 and MV3](#manifests--mv2-and-mv3)
6. [Shared Types — src/types.d.ts](#shared-types--srctypesdts)
7. [Keybinding System — src/lib/shared/keybindings.ts](#keybinding-system--srclibsharedkeybindingsts)
8. [Content Script Boot — src/entryPoints/contentScript](#contentScript-boot--srcentryPointscontentScript)
9. [Background Process — src/entryPoints/background](#background-process--srcentryPointsbackground)
10. [Search Current Page — src/lib/searchCurrentPage](#search-current-page--srclibsearchcurrentpage)
11. [Search Open Tabs — src/lib/searchOpenTabs](#search-open-tabs--srclibsearchopentabs)
12. [Tab Manager — src/lib/tabManager](#tab-manager--srclibtabmanager)
13. [Bookmarks — src/lib/bookmarks](#bookmarks--srclibbookmarks)
14. [Help — src/lib/help](#help--srclibhelp)
15. [Shared Utilities — src/lib/shared](#shared-utilities--srclibshared)
16. [Panel Lifecycle + Guards](#panel-lifecycle--guards)
17. [Performance Patterns](#performance-patterns)
18. [UI Conventions (Footers, Vim, Filters)](#ui-conventions-footers-vim-filters)
19. [Patterns Worth Reusing](#patterns-worth-reusing)
20. [Maintainer Operating Mode](#maintainer-operating-mode)
21. [System Invariants](#system-invariants)
22. [Algorithm + Complexity Ledger](#algorithm--complexity-ledger)
23. [Bug Triage + Patch Runbook](#bug-triage--patch-runbook)
24. [Incident Playbooks](#incident-playbooks)
25. [Interview Prep + Codebase Walkthrough](#interview-prep--codebase-walkthrough)
26. [Final Thought](#final-thought)

---

## Project Overview

Harpoon Telescope is a keyboard-first browser extension inspired by Neovim plugins:

- Tab Manager (Harpoon): pin up to 4 tabs with scroll restore and sessions.
- Search Current Page (Telescope): fuzzy grep with structural filters + preview.
- Search Open Tabs (Frecency): ranked open tabs by frequency and recency.
- Bookmarks: two-pane browser with tree views and confirmations.

Everything runs in plain TypeScript with no UI framework. Overlays are Shadow DOM panels injected into the active page.
Engineering promise: stay Ghostty-inspired and browser-primitive (DOM/Shadow DOM/WebExtension APIs), keep UI latency low, minimize visual glitching, and preserve Firefox/Chrome parity.

---

## Data-Flow Walkthrough (Start -> End -> Start)

This section is the heart of the file. It shows how data moves through the system so I can rebuild it from memory. Each flow is a lesson in architecture, state management, algorithms, and critical thinking.

How to naturally walk these chapters:

1. Read one flow from trigger to side effect.
2. Extract the core concepts from that flow.
3. Identify the exact algorithmic steps used.
4. Do one no-AI rep (small change from memory, then verify in code).
5. Run the relevant tests or manual checks.
6. Explain the flow out loud in interview style.
7. Capture one lesson I can reuse in another codebase.

---

### Flow A — Open a Panel and Search

User presses `Alt+F` on any page. The content script's global keydown handler in `src/lib/appInit/appInit.ts` catches the event, and `matchesAction(e, config, "global", "searchInPage")` returns true. The handler calls `openSearchCurrentPage(config)` from `src/lib/searchCurrentPage/searchCurrentPage.ts`, which creates a Shadow DOM host (`#ht-panel-host`) and builds the search UI inside it.

The content script owns DOM access because the background cannot touch page DOM — this is a fundamental browser security boundary. Panel lifecycle is one layer of this architecture: host integrity is validated before open, and open paths fail closed (`dismissPanel()`) on sync or async initialization failures, so stale host state does not poison later feature flows.

When the user types a query, the `input` event fires and updates the closure-scoped state — `currentQuery` holds what the user typed, `activeFilters` holds structural filters like `/code` or `/headings`. Then `applyFilter()` runs `grepPage()` from `src/lib/searchCurrentPage/grep.ts`, which populates `results`. Finally `renderResults()` updates the DOM and `updatePreview()` shows context for the highlighted item.

This is unidirectional data flow: events mutate state, state drives render, render never mutates state. The pattern prevents bugs where UI and state diverge.

The challenge is performance. The DOM can have thousands of nodes, and scanning all of them on every keystroke would freeze the UI. All JavaScript runs on a single thread — the main thread — with no parallelism. The event loop processes one event at a time: keydown fires, the handler runs synchronously, render functions update DOM synchronously, then the browser paints. If any step takes longer than ~16ms (the budget for 60fps), the UI janks.

The solution uses several techniques. First, `grepPage()` walks the DOM once and caches the lines, invalidating on mutations with a 500ms debounce. This means stale results for up to 500ms after DOM changes, but no repeated full-DOM walks — O(n) once instead of O(n) per keystroke. Second, fuzzy scoring uses a character-by-character algorithm that iterates once per query character, avoiding regex catastrophic backtracking. Third, even if 10,000 lines match, `MAX_RESULTS` caps the list at 200, bounding rendering work. Fourth, virtual scrolling keeps only ~25 DOM nodes in the results list, recycling them as the user scrolls — O(visible) rendering instead of O(total). Fifth, expensive fields like `domContext`, `ancestorHeading`, and `href` are computed lazily in `updatePreview()`, not upfront for all 200 results.

When the user navigates with arrows (or j/k in vim mode), `activeIndex` changes, `renderResults()` highlights the new item, and `updatePreview()` shows its context. When the user presses Enter, the overlay scrolls to the target element using `src/lib/shared/scroll.ts` and closes.

The lesson here is a checklist for search UI performance: Am I re-scanning data on every keystroke? Cache it. Am I rendering all results? Virtual scroll. Am I doing expensive work upfront? Lazy compute. Am I using regex? Watch for backtracking.

Concepts to internalize from this flow:

1. **Pipeline thinking:** input event -> query parse -> ranked filtering -> render -> side effect.
2. **Separation of concerns:** search algorithm is in `grep.ts`, UI orchestration in `searchCurrentPage.ts`.
3. **Lifecycle safety:** panel open paths must fail closed so stale UI state never blocks future opens.
4. **Performance budget mindset:** optimize for keystroke latency first, not theoretical elegance.

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

**Files to trace:** `src/lib/appInit/appInit.ts` (global key handler + host integrity guard), `src/lib/searchCurrentPage/searchCurrentPage.ts` (overlay UI + state), `src/lib/searchCurrentPage/grep.ts` (DOM walking + fuzzy scoring), `src/lib/shared/panelHost.ts` (host lifecycle + dismiss), `src/lib/shared/scroll.ts` (scroll-to-text).

Visual map (Flow A):

```text
[User Alt+F]
    |
    v
[appInit.ts keydown handler] --matchesAction--> [openSearchCurrentPage()]
    |
    v
[Shadow DOM panel host + local state]
    |
    v
[input event] -> [currentQuery/activeFilters update]
    |
    v
[grepPage cache+score] -> [results]
    |
    v
[renderResults + updatePreview]
    |
    v
[Enter] -> [scroll.ts scroll-to-target] -> [dismiss panel]
```

Practice loop (no AI, data-flow first):

1. Trace: keydown -> `matchesAction` -> `openSearchCurrentPage` -> `applyFilter` -> `grepPage` -> `renderResults` -> `updatePreview`.
2. Modify: add one new slash filter token end-to-end (`searchCurrentPage.ts` parser + `grep.ts` collector + UI pills/title badges).
3. Verify: run tests plus manual check on a long document; confirm no panel duplication and no visible keystroke lag.
4. Explain: defend why caching + virtualization + lazy preview are combined, not optional.

Failure drill:

1. Temporarily bypass the panel guard and trigger `Alt+F` repeatedly.
2. Observe failure mode (duplicate hosts, conflicting key handlers, visual glitches).
3. Revert, then explain exactly why guard placement in `appInit.ts` is a correctness boundary.

Growth checkpoint:

1. Junior signal: can trace every state variable (`currentQuery`, `activeFilters`, `results`, `activeIndex`) through one full query cycle.
2. Mid signal: can add a new filter and keep ranking deterministic with tests.
3. Senior signal: can quantify a latency budget change and justify a tradeoff with data.

---

### Flow B — Tab Manager Add + Jump

User presses `Alt+Shift+T` to add the current tab. The content script in `src/lib/appInit/appInit.ts` catches the keybind and sends `{ type: "TAB_MANAGER_ADD" }` to the background. Only the background has `browser.tabs.*` API access — content scripts are sandboxed and cannot manipulate browser tabs directly. This is the browser's security model.

The background bootstrap in `src/entryPoints/background/background.ts` delegates tab-manager state to `src/lib/background/tabManagerDomain.ts`. That domain first calls `ensureTabManagerLoaded()` to load state from storage if needed. MV3 service workers can be killed at any time, so every stateful handler calls this guard before reads/writes — it's idempotent and safe to call repeatedly. Then the domain sends `GET_SCROLL` back to the content script to capture the current scroll position, because scroll state is page-owned and the background cannot read `window.scrollX` directly. With scroll position in hand, it creates a `TabManagerEntry`, compacts slots to keep them sequential (1, 2, 3 instead of 1, 3, 4), saves to `browser.storage.local`, and returns. The content script shows a feedback toast via `src/lib/shared/feedback.ts` saying "Added to Tab Manager [slot]".

Later, the user presses `Alt+1` to jump. The content script sends `{ type: "TAB_MANAGER_JUMP", slot: 1 }`. The background finds the entry and either activates the existing tab or, if it was closed, re-opens the URL in a new tab and restores scroll.

There are two open paths in the full system: page-level keydown in the content script (normal path) and browser command shortcuts routed through `src/lib/background/commandRouter.ts` (command-declared actions). The command router uses bounded retries when delivering `OPEN_*` messages, and selected panel-open data fetches use retries too. This is readiness policy, not business logic: it protects all feature flows from transient context startup gaps.

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
6. On command-triggered panel opens, retry content message delivery with bounded backoff.

Extension path (how to safely add capability):

1. Add new tab-manager message type in background switch.
2. Wire keybind/action in `appInit.ts`.
3. Update panel behavior in `tabManager.ts`.
4. Preserve slot compaction and closed-entry semantics.

Interview articulation:

1. "I designed around unstable tab IDs by storing URL + scroll and recovering state."
2. "I used explicit message contracts to separate page and browser responsibilities."
3. "I guarded state access for MV3 worker restarts."

**Files to trace:** `src/lib/appInit/appInit.ts` (keybind handler), `src/entryPoints/background/background.ts` (router composition), `src/lib/background/commandRouter.ts` (command delivery retries), `src/lib/background/tabManagerDomain.ts` (state + commands), `src/lib/background/tabManagerMessageHandler.ts` (runtime API surface), `src/lib/tabManager/tabManager.ts` (open-list retry), `src/lib/shared/feedback.ts` (toast).

Visual map (Flow B):

```text
[User Alt+Shift+T in page]
    |
    v
[Content script keydown]
    |
    v
sendMessage TAB_MANAGER_ADD ----------------------------.
                                                       |
                                                       v
                                        [Background router/domain]
                                                       |
                                                       v
                                 ensureLoaded -> GET_SCROLL -> save storage
                                                       |
                                                       v
<---------------------------- response -----------------'
    |
    v
[Content script toast feedback]

[User Alt+1] -> TAB_MANAGER_JUMP -> activate tab OR reopen URL + restore scroll
```

Practice loop (no AI, data-flow first):

1. Trace: keydown -> runtime message -> background domain guard -> storage write -> feedback toast.
2. Modify: add one safe tab-manager action (for example, "move slot up") across message contract, domain operation, and overlay keybind.
3. Verify: test add/jump/reopen flows after browser restart; confirm slot compaction and closed-entry behavior still hold.
4. Explain: defend why background owns canonical state and content scripts remain stateless views.

Failure drill:

1. Remove `ensureTabManagerLoaded()` from one handler and trigger add/list/jump in a fresh worker lifecycle.
2. Observe stale or missing state behavior.
3. Reintroduce guard and explain idempotent-load patterns for MV3 worker restarts.

Growth checkpoint:

1. Junior signal: can explain why tab IDs are unstable and why URL+scroll is persisted.
2. Mid signal: can add a new command without breaking message contracts.
3. Senior signal: can reason about race ordering and prove sequential event-loop safety.

---

### Flow C — Bookmarks

User presses `Alt+B` to open Bookmarks. The content script opens the overlay from `src/lib/bookmarks/bookmarks.ts` and immediately sends `{ type: "BOOKMARK_LIST" }` to the background. The background calls `browser.bookmarks.getTree()` — an API only available in the background context — and returns flattened entries. Until that Promise resolves, the overlay shows nothing or a loading state. Once data arrives, it's stored in `allEntries` and rendered synchronously. No partial updates, no flickering.

The overlay is a pure view layer with its own local state for navigation and filtering. It does not cache the bookmark tree long-term — it requests fresh data on every open, keeping things simple and avoiding stale-data bugs.

The challenge is providing fast filtering over a potentially large dataset (thousands of bookmarks) while keeping the tree context visible so users know where things are. The solution uses a two-pane layout: the left pane shows filtered results, the right pane shows the folder tree. Users can switch focus with `Tab`/`f` for input/results and `l`/`h` for tree/results. This adds UI complexity, but users always see their location in the hierarchy.

The overlay manages multiple focus targets through a `detailMode` state machine. In `"tree"` mode, the tree is visible but results have focus. In `"treeNav"` mode, the tree has a cursor and results are dimmed. When the user presses `d` to delete, `detailMode` becomes `"confirmDelete"` and a confirm prompt appears. Pressing `y` confirms, sends `{ type: "BOOKMARK_REMOVE", id }` to the background, and refreshes the list. Pressing `n` cancels back to tree mode. Each state defines what the UI looks like and which keys do what — there's no magic, every transition is explicit in the key handler.

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

**Files to trace:** `src/lib/bookmarks/bookmarks.ts` (overlay UI + state), `src/lib/background/bookmarkDomain.ts` (bookmark tree + usage), `src/lib/background/bookmarkMessageHandler.ts` (API wrappers).

Visual map (Flow C):

```text
[User Alt+B]
    |
    v
[bookmarks overlay opens in content script]
    |
    v
sendMessage BOOKMARK_LIST ------------------------------.
                                                       |
                                                       v
                                      [Background bookmarkDomain]
                                                       |
                                                       v
                                     browser.bookmarks.getTree()
                                                       |
                                                       v
<----------------------- flattened entries -------------'
    |
    v
[allEntries state] -> [filter + rank] -> [left results + right tree]
    |
    v
[detailMode transitions: tree / treeNav / confirmDelete]
```

Practice loop (no AI, data-flow first):

1. Trace: open overlay -> request list -> background API -> local `allEntries` -> filter/rank -> render left/right panes.
2. Modify: add a new scoped filter (for example `/domain`) and define explicit ranking tie-breakers.
3. Verify: run tests/manual checks for tree focus, confirm-delete mode, and footer hint consistency.
4. Explain: defend the `detailMode` state machine as protection against ambiguous keyboard behavior.

Failure drill:

1. Force an invalid mode transition (for example, allow delete confirm while tree cursor is stale).
2. Observe UI inconsistency and keybinding confusion.
3. Repair transition table and explain why explicit finite states reduce hidden UX bugs.

Growth checkpoint:

1. Junior signal: can map each key to state transitions in one mode.
2. Mid signal: can add a new filter + ranking rule with no regressions in focus behavior.
3. Senior signal: can simplify mode logic while preserving keyboard predictability.

---

### Flow D — Session Restore on Startup

User closes the browser with tabs pinned in Tab Manager. When the browser reopens, `browser.runtime.onStartup` fires and is handled by `src/lib/background/startupRestore.ts` (registered from `src/entryPoints/background/background.ts`). Tab IDs are not stable across browser restarts — the old `tabManagerList` is useless because all those tab IDs now point to nothing. The background clears the stale list and loads `tabManagerSessions` from storage to prepare for restore.

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

**Files to trace:** `src/lib/background/startupRestore.ts` (startup handler), `src/lib/tabManager/session.ts` (session restore UI).

Visual map (Flow D):

```text
[Browser startup]
    |
    v
onStartup -> startupRestore.ts
    |
    v
[load sessions + clear stale runtime list]
    |
    v
setTimeout(initial delay)
    |
    v
try send SHOW_SESSION_RESTORE to active tab
    | success                          | failure
    v                                  v
[restore UI shown]              [wait + retry up to max]
                                         |
                                         v
                             [manual fallback remains available]
```

Practice loop (no AI, data-flow first):

1. Trace: `onStartup` -> load sessions -> clear stale runtime list -> delayed prompt send -> retries -> restore UI -> `SESSION_LOAD`.
2. Modify: tune retry timing behind constants and document the startup latency tradeoff.
3. Verify: simulate startup with delayed content-script readiness and confirm bounded retries + manual fallback.
4. Explain: defend why this is eventual consistency, not synchronous initialization.

Failure drill:

1. Remove retry/backoff and keep single-shot prompt delivery.
2. Reproduce missing restore prompt on slow startup tabs.
3. Restore retries and explain why bounded retry with fallback is more resilient than aggressive polling.

Growth checkpoint:

1. Junior signal: can describe lifecycle mismatch between background and content script readiness.
2. Mid signal: can tune retry strategy safely and keep behavior deterministic.
3. Senior signal: can design startup recovery paths that degrade gracefully under partial failure.

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
│   ├── entryPoints/
│   │   ├── background/
│   │   │   └── background.ts
│   │   ├── contentScript/
│   │   │   └── contentScript.ts
│   │   ├── toolbarPopup/
│   │   │   ├── toolbarPopup.ts
│   │   │   ├── toolbarPopup.html
│   │   │   └── toolbarPopup.css
│   │   └── optionsPage/
│   │       ├── optionsPage.ts
│   │       ├── optionsPage.html
│   │       └── optionsPage.css
│   ├── lib/
│   │   ├── appInit/                 # contentScript bootstrap
│   │   ├── background/              # background domains + runtime/command routers
│   │   ├── shared/                  # keybindings, helpers, sessions, scroll, feedback
│   │   ├── tabManager/              # Tab Manager panel + sessions UI
│   │   ├── searchCurrentPage/       # Telescope search (current page)
│   │   ├── searchOpenTabs/          # Frecency open tabs list
│   │   ├── bookmarks/               # Bookmarks browser
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

- `src/entryPoints/background/background.ts` -> `dist/background.js`
- `src/entryPoints/contentScript/contentScript.ts` -> `dist/contentScript.js`
- `src/entryPoints/toolbarPopup/toolbarPopup.ts` -> `dist/toolbarPopup/toolbarPopup.js`
- `src/entryPoints/optionsPage/optionsPage.ts` -> `dist/optionsPage/optionsPage.js`

**Why IIFE?**

MV2 background + content scripts do not support ES modules. They run in the global scope. IIFE wraps the code so variables don't leak. This works on both MV2 and MV3.

**Why esbuild?**

It's fast (10-100x faster than webpack) and simple. The build script is ~50 lines, not hundreds.

**CSS as text:**

CSS is loaded as text via esbuild loader (`{ '.css': 'text' }`). This allows injecting styles into Shadow DOM as a `<style>` tag, keeping overlay styles isolated from page CSS.

**Compatibility check:**

`npm run verify:compat` validates MV2/MV3 permissions and ensures MV3 stays within Chrome suggested-command limits.

**Store policy check:**

`npm run verify:store` validates manifest/store/privacy consistency: permissions must match docs, privacy claims must stay present, and documented storage caps must match source constants.

**Upgrade migration check:**

`npm run verify:upgrade` runs fixture snapshots through versioned storage migrations to prove old installs upgrade safely.

**Release flow:**

Before cutting a release, run `npm run ci` (includes all verify scripts), then use `STORE.md` and `PRIVACY.md` as the canonical store-submission text.

Practice loop (no AI, chapter-specific):

1. Trace: `package.json` scripts -> verify scripts -> build outputs in `dist/`.
2. Modify: add one new guardrail check script and wire it into `npm run ci`.
3. Verify: run the new script directly, then run `npm run ci` and confirm failure/success behavior.
4. Explain: defend why release safety belongs in automation, not memory.

Failure drill:

1. Intentionally desync one manifest/doc claim in a temporary branch.
2. Run `npm run verify:store` and observe the gate fail.
3. Fix the drift and explain the exact class of release bug this prevents.

Growth checkpoint:

1. Junior signal: can explain every CI script and what risk it catches.
2. Mid signal: can add a new release gate without breaking developer flow.
3. Senior signal: can tune guardrails for signal over noise (strict enough, not brittle).

---

## Manifests — MV2 and MV3

- Firefox/Zen use MV2 (`manifest_v2.json`).
- Chrome uses MV3 (`manifest_v3.json`) with a service worker.

**Why two manifests?**

Chrome moved to MV3; Firefox still supports MV2. MV3 changes background lifecycle semantics (service workers can be suspended), so we keep both manifests for cross-browser compatibility.

**How we handle commands across browsers:**

Most shortcuts go through the content script's `keydown` listener, not `browser.commands`. The manifests keep only core suggested commands (open/add/search) for MV3 compatibility, while the content script handles slot jumps and the full keybinding system (including user-customized bindings and panel-local behavior).

Practice loop (no AI, chapter-specific):

1. Trace: manifest command declarations -> runtime keybinding behavior -> browser-specific constraints.
2. Modify: add one command-related change and keep MV2/MV3 parity.
3. Verify: run `npm run verify:compat` and manually test the shortcut in Firefox + Chrome builds.
4. Explain: defend why command scope is split between manifests and content-script routing.

Failure drill:

1. Remove or rename a required command in one manifest only.
2. Run compatibility checks and observe divergence detection.
3. Restore parity and explain how MV2/MV3 lifecycle differences affect design choices.

Growth checkpoint:

1. Junior signal: can explain why two manifests exist.
2. Mid signal: can modify permissions/commands safely across both manifests.
3. Senior signal: can predict cross-browser regression risk before testing.

---

## Shared Types — src/types.d.ts

This file defines global types shared across background + content + UI:

- `TabManagerEntry`, `TabManagerSession`
- `GrepResult`, `SearchFilter`
- `BookmarkEntry`, `FrecencyEntry`

**Why ambient types?**

Ambient types (in `.d.ts`) are globally available without imports. This reduces boilerplate for interfaces used across 10+ files.

**Tradeoff:** No explicit imports means it's harder to trace where a type is defined. Mitigated by having one central `types.d.ts`.

---

## Keybinding System — src/lib/shared/keybindings.ts

Keybinding storage and matching are centralized here:

- Stored in `browser.storage.local` and merged with defaults for forward compatibility.
- Vim navigation is always enabled (adds j/k, never replaces basic keys).
- Core action matching is centralized (`matchesAction`), and panel-local controls (`d/m/l/h/f` plus `Shift+C clear-search`) are handled directly inside overlay key handlers.

**Why merge with defaults?**

When the extension updates and adds new shortcuts, users with saved keybindings won't have the new keys. `mergeWithDefaults()` overlays saved bindings onto the full default config, so new actions get their defaults.

**Why vim as additive?**

Arrow keys always work. j/k are bonuses on top. Users don't need to rely on vim motions to use the extension.

---

## Content Script Boot — src/entryPoints/contentScript

Entry point `src/entryPoints/contentScript/contentScript.ts` is minimal: it calls `initApp()` in `src/lib/appInit/appInit.ts`.

`initApp()` handles:

- cleanup on extension reload (`window.__harpoonTelescopeCleanup`)
- keybinding cache + invalidation
- global key handler (panel open commands)
- message router (`GREP`, `GET_SCROLL`, `OPEN_*`)

**Why cleanup on reload?**

Firefox caches content scripts. On extension reload, the old script stays alive. Without cleanup, you'd have duplicate event listeners. The cleanup function removes old listeners before setting up new ones.

**Why cache keybindings?**

Every keypress calls `getConfig()`. Without caching, that's an async message round-trip on every keypress — noticeable latency. The cache loads once and invalidates on storage changes.

---

## Background Process — src/entryPoints/background

Background entry `src/entryPoints/background/background.ts` orchestrates:

- tab manager domain (`src/lib/background/tabManagerDomain.ts`)
- bookmark domain (`src/lib/background/bookmarkDomain.ts`)
- runtime routers/handlers (`src/lib/background/*MessageHandler.ts`, `runtimeRouter.ts`)
- startup restore coordination (`src/lib/background/startupRestore.ts`)

**Key patterns:**

- **Lazy-load guards:** `ensureTabManagerLoaded()`, `ensureFrecencyLoaded()`, and bookmark/session load helpers. MV3 service workers can restart anytime, so stateful handlers call relevant guards before read/write.

- **State reconciliation:** Before returning tab manager list, query all open tabs and mark entries as `closed` if their tab ID no longer exists.

- **Domain routing:** `background.ts` stays thin; handler/domain modules keep privileged logic isolated and easier to review.
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
- session load uses preview + minimal slot-level load plan legend (`NEW (+)`, `DELETED (-)`, `REPLACED (~)`, `UNCHANGED (=)`)
- load/save session panes support keyboard focus cycling (`Tab` / `Shift+Tab`)
- session list search uses `Search Sessions . . .` and `Shift+C clear-search`

**Why max 4 slots?**

Opinionated design. More slots = harder to remember which is which. 4 is enough for a focused workflow.

---

## Bookmarks — src/lib/bookmarks

Two-pane UI (results + tree). `detailMode` controls tree focus and confirm states.

- `/folder` filter for folder path
- `m` opens move picker
- `l` focuses tree, `h` returns to results
- `Shift+C clear-search` works from input/results/tree
- move/confirm prompts use `y` confirm and `n` cancel
- `Ctrl+D/U` supports half-page jumps in bookmark results/tree and add-bookmark list steps
- add-bookmark applies a final y/n confirmation card with `Title` and `Destination path > {path}`

**Why tree-first?**

Context matters. Seeing the folder tree while filtering helps users understand where bookmarks live.

---

## Help — src/lib/help

Help overlay builds sections from live keybinding config. It documents the panel controls and filters.

- includes session-specific controls (focus toggle, search focus, clear-search, load confirm/cancel)
- key labels mirror current keybinding config instead of hard-coded defaults

**Why live keybindings?**

If the user customizes shortcuts, the help menu reflects their actual bindings, not the defaults.

---

## Shared Utilities — src/lib/shared

- `helpers.ts`: `escapeHtml`, `escapeRegex`, `buildFuzzyPattern`, `extractDomain`
- `filterInput.ts`: shared slash-filter parsing used by search and bookmark overlays
- `panelHost.ts`: shadow host, base styles, focus trapping
- `scroll.ts`: scroll-to-text highlight
- `feedback.ts`: toast messages
- `sessions.ts`: session CRUD helpers
- `frecencyScoring.ts`: frecency scoring + eviction
- `runtimeMessages.ts`: typed message contracts for background <-> content runtime channels

Practice loop (no AI, chapter-specific):

1. Trace one shared helper from caller -> helper -> returned value usage in UI/background.
2. Modify one shared contract in `runtimeMessages.ts` and update all call sites.
3. Verify: run lint/typecheck/tests and manually trigger the affected runtime flow.
4. Explain: defend why shared modules should stay minimal and stable.

Failure drill:

1. Introduce a contract mismatch between sender and receiver payload shape.
2. Observe TypeScript/runtime failure points.
3. Repair and explain why typed message contracts reduce cross-context bugs.

Growth checkpoint:

1. Junior signal: can find where a shared util is consumed.
2. Mid signal: can evolve a shared contract without hidden breakage.
3. Senior signal: can decide what belongs in `shared` vs feature-specific modules.

---

## Panel Lifecycle + Guards

- panels are isolated Shadow DOM trees
- global keybinds are blocked while a live panel is open
- host integrity is checked before open; stale/empty host is dismissed automatically
- `openPanel()` is fail-closed (sync + async errors both call `dismissPanel()`)
- panel openers fail-closed too (top-level catch calls `dismissPanel()`)
- command-triggered open messages use bounded retries for content-script readiness
- `dismissPanel()` tears down the host and registered panel cleanup

This layer is cross-cutting infrastructure for every feature module. It should stay generic and reusable, with feature-specific logic remaining in each panel/domain module.

**Why block global keybinds when panel is open?**

Prevents conflicts. `Alt+F` opens the panel; once open, pressing `Alt+F` should not try to open another. The panel guard ensures only the panel's key handler responds.

**Failure recovery path (must be second nature):**

1. Trigger arrives (keydown or runtime command message).
2. Validate host integrity (clear stale host if needed).
3. Attempt open through guarded `openPanel(...)`.
4. If init fails at any point, fail closed via `dismissPanel()`.
5. Next shortcut can open immediately (no ghost host lockout).

---

## Performance Patterns

- **Virtual lists with DOM pooling:** Only ~25 DOM nodes exist; they're recycled as the user scrolls.
- **rAF throttled updates:** Rendering is scheduled via `requestAnimationFrame` to batch DOM writes.
- **Measured hot paths:** `withPerfTrace(...)` instruments filter/render hotspots and writes stats to `globalThis.__HT_PERF_STATS__`.
- **Regression budgets:** `src/lib/shared/perfBudgets.json` keeps expected latency envelopes explicit in code review + tests.
- **Cached DOM grep + mutation invalidation:** Walk the DOM once, cache lines, invalidate on changes.
- **Lazy computation:** Expensive fields (domContext, ancestorHeading) are computed on-demand, not upfront.
- **Responsive pane switching:** two-pane overlays collapse to stacked panes on smaller viewports.

Practice loop (no AI, chapter-specific):

1. Trace one hot path (`filter` or `render`) from event handler to measured trace output.
2. Modify one performance-sensitive block (for example list rendering) with a measurable hypothesis.
3. Verify: inspect perf traces + run perf guardrail tests.
4. Explain: justify tradeoff between readability and latency on that path.

Failure drill:

1. Temporarily disable virtualization or rAF scheduling in a local branch.
2. Reproduce jank on larger datasets.
3. Restore optimization and explain the before/after complexity and frame-budget impact.

Growth checkpoint:

1. Junior signal: can identify which code path is hot.
2. Mid signal: can reduce latency without changing behavior.
3. Senior signal: can set and defend measurable budgets in code review.

---

## UI Conventions (Footers, Vim, Filters)

- Footer order: nav -> secondary (list/tree) -> action (clear/del/move) -> primary (open) -> close/back
- Footer labels: uppercase key + lowercase label (ex: `D del`)
- Vim navigation: j/k aliases are always enabled
- Clear-search: `Shift+C` works from input/results/tree contexts
- Search input placeholders follow `Search <Panel Name> . . .` across session load, bookmarks, open tabs, and current-page search

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

## Maintainer Operating Mode

Definition: I am not only shipping features. I am preserving system behavior, invariants, and developer velocity.

Release-quality checklist for every change:

1. Identify the owning layer first (content UI, background domain, shared contract, build/release).
2. State the invariant being changed or preserved before coding.
3. Implement the smallest coherent patch that keeps module boundaries intact.
4. Prove behavior with one happy-path check and one failure-path check.
5. Add regression coverage (test and/or documented manual repro).
6. Update docs where behavior contracts changed (`learn.md`, `README.md`, `STORE.md`, `PRIVACY.md` when relevant).
7. Run quality gates: lint, tests, and compatibility/store checks as appropriate.

What "ownership" means in this repo:

1. I can explain any runtime message from sender to handler to side effect.
2. I can explain why state belongs to background vs content script.
3. I can explain one tradeoff per subsystem (performance, complexity, UX, reliability).
4. I can debug failures without relying on framework abstractions.

---

## System Invariants

These are non-negotiable truths. If one breaks, behavior drifts.

Global/runtime invariants:

1. Background owns canonical browser state (`tabs`, `sessions`, `bookmarks`, frecency persistence).
2. Content overlays are ephemeral views driven by runtime messages and local UI state.
3. Runtime message shapes stay explicit and synchronized across sender/receiver.
4. Only one live panel host may exist at a time.

Tab Manager invariants:

1. Slots remain compacted and ordered from 1..N.
2. Closed entries stay representable and recoverable by URL.
3. Scroll coordinates are captured/restored as part of tab/session workflow.
4. Session capacity and slot capacity constraints are enforced consistently.

Session invariants:

1. Session names are unique case-insensitively.
2. Session list ordering is deterministic (recent-first when listed).
3. Load planning and load execution are consistent (slot-plan rows and totals align with actual action).
4. Confirmation flows must be explicit and reversible.

Search/bookmark invariants:

1. Query -> filter -> rank -> render pipeline is deterministic for the same input state.
2. Focus behavior is explicit (`input`, `results`, tree/detail modes) and keyboard-safe.
3. Virtualized lists only render visible windows plus buffer.

Build/release invariants:

1. MV2/MV3 manifests remain policy-compatible with behavior and docs.
2. Storage migrations are forward-compatible and test-gated.
3. Store claims and privacy claims match actual permissions and persisted data.

---

## Algorithm + Complexity Ledger

This is the quick reference I should be able to explain in interviews and design reviews.

| Subsystem | Core operation | Complexity (high-level) | Main challenge | Mitigation used |
|---|---|---|---|---|
| Search Current Page | Cached line extraction + query ranking | Cache build `O(N)` over candidate nodes; query pass approximately `O(C * Q)` + sort cap | Large DOM + keystroke latency | Cached extraction, capped results, virtual scrolling, lazy preview enrichment |
| Search Open Tabs | Title/URL match + ranked sort | `O(T)` matching + `O(T log T)` sort | Fast ranking without UI jank | Ranked match tiers, bounded rendering, rAF scheduling |
| Bookmarks Panel | Filter + tree/detail state transitions | `O(B)` filtering + virtualized rendering | Multi-mode keyboard UX complexity | Explicit mode/state machine + pooled rendering |
| Tab Manager Jump | Slot lookup + tab activate/reopen | `O(S)` where `S <= 4` | Unstable tab IDs across lifecycle/restart | Persist URL + scroll, closed-entry recovery, reconcile against open tabs |
| Session Load Plan | Slot-by-slot unchanged/new/deleted/replaced computation | `O(E)` where `E` session entries | Predictable load summary against current tab-manager state | URL normalization + same-slot comparison |
| Session Load Execute | Reuse existing or open new tabs | `O(E)` plus tab API latency | Consistent restore with partial failures | Per-entry fallback (reuse -> open), queued scroll restore, graceful skip on open failure |
| Panel Lifecycle | Open/close/focus/error handling | `O(1)` control flow | Ghost host and readiness race conditions | Host-integrity checks, fail-closed open paths, bounded retries |

When discussing complexity, always include:

1. Data size variable (`N`, `T`, `B`, `E`) and where it comes from.
2. Practical cap/guardrail used in product behavior.
3. The dominant user-facing risk (latency, stale state, focus confusion).

---

## Bug Triage + Patch Runbook

Use this every time before coding a fix.

1. Reproduce precisely.
2. Classify the layer: UI state, runtime messaging, background domain, storage/migration, or build/release.
3. Capture expected invariant and observed invariant break.
4. Isolate minimal failing path in code (function + message + state transition).
5. Patch minimally at the owning layer (avoid cross-layer band-aids first).
6. Verify with:
   - one direct repro replay,
   - one adjacent regression check,
   - one failure-path check.
7. Add or update tests/guardrails where practical.
8. Update docs that define behavior contracts.

Patch quality questions:

1. Does this fix preserve existing contracts in other panels/flows?
2. Does this introduce hidden coupling between modules?
3. If this fails again, will it fail safe (recoverable) or fail dangerous (lock/freeze/data drift)?

---

## Incident Playbooks

Incident: panel shortcut does nothing.

1. Check panel host lifecycle (`createPanelHost`, `dismissPanel`, cleanup registration).
2. Verify global keybinding path in `appInit.ts`.
3. Verify runtime command path in `commandRouter.ts`.
4. Confirm stale host recovery and retry paths are active.

Incident: tab jump/session load restores wrong scroll location.

1. Verify capture points (`GET_SCROLL` capture before switch/save).
2. Verify saved session/tab entry contains expected `scrollX/scrollY`.
3. Verify restore queue + delivery (`SET_SCROLL`, ready/retry path).
4. Check restricted-page edge cases where content script messaging is blocked.

Incident: session load summary differs from observed load.

1. Compare load-plan computation vs load execution path.
2. Verify URL normalization and same-slot comparison behavior.
3. Confirm session list snapshot did not change between plan and confirm.

Incident: cross-context drift (UI shows stale data).

1. Verify background remains canonical source and list fetch occurs on open.
2. Confirm message contract payloads match expected types.
3. Verify no stale cached UI list survives mode transitions.

---

## Interview Prep + Codebase Walkthrough

Use this as the final section before interviews or live walkthroughs.

10-minute walkthrough script:

1. Product + target user (30s): keyboard-first tab/search workflow for power users.
2. Architecture (90s): content script owns page DOM, background owns browser APIs + canonical state, runtime messages connect them.
3. Flow A demo (2 min): keypress -> search pipeline -> cached grep -> virtualized render -> scroll side effect.
4. Flow B demo (2 min): add/jump tab path, unstable tab-ID problem, URL+scroll recovery strategy.
5. Flow C demo (90s): two-pane state machine and explicit mode transitions.
6. Flow D demo (90s): startup race handling with bounded retries and fallback.
7. Release confidence (60s): CI gates (`verify:compat`, `verify:upgrade`, `verify:store`) + Firefox/Chrome builds.

Interview question drill:

1. Why no framework?
Answer frame: browser primitives reduce overhead, keep control over focus/latency, and map well to extension constraints.
2. How do you replace framework conveniences in vanilla TypeScript?
Answer frame: explicit state machines for UI modes, shared panel-host lifecycle contracts, typed runtime message contracts, virtualized lists, and deterministic keyboard/focus management.
3. How do you prevent state drift between contexts?
Answer frame: background is canonical source of truth, overlays request fresh state, message contracts are explicit.
4. What was the hardest bug class?
Answer frame: lifecycle and readiness races (MV3 worker restart, startup prompt delivery), solved with idempotent guards and bounded retries.
5. How do you prove performance claims?
Answer frame: virtualized rendering, rAF scheduling, perf traces, and CI budget tests.
6. How is this extension store-ready?
Answer frame: manifest/privacy/store docs are policy-checked; compatibility and migration gates run in CI.

Proof-of-ownership checklist (run this per feature):

1. Flow A ownership proof: trace `appInit.ts` -> `searchCurrentPage.ts` -> `grep.ts`; run search-related tests/manual grep pass; implement one new slash filter; explain ranking + virtualization tradeoffs.
2. Flow B ownership proof: trace runtime message path into `tabManagerDomain.ts`; run tab-manager add/jump/session checks; implement one command evolution with contract updates; explain tab-ID instability design.
3. Flow C ownership proof: trace bookmarks request -> render -> mode transitions; run two-pane and delete-confirm checks; implement one new scoped filter; explain state-machine invariants.
4. Flow D ownership proof: trace startup restore retries in `startupRestore.ts`; run startup/fallback checks; tune retry constants safely; explain eventual consistency vs synchronous assumptions.
5. Platform ownership proof: run `npm run ci`; explain what `verify:compat`, `verify:upgrade`, and `verify:store` each prevent in release risk.

30/60/90 growth track in this repo:

1. Day 1-30 (Junior -> strong junior): trace all four flows, pass all tests locally, ship one low-risk feature per flow with tests.
2. Day 31-60 (Mid ramp): own one cross-cutting refactor (message contracts or panel host tokens), keep CI green, and write regression tests for one bug class.
3. Day 61-90 (Senior trajectory): lead one design change with explicit tradeoffs, define/update one engineering guardrail, and defend architecture + failure strategy in interview-style review.

Quick summary of everything learned:

1. I can trace real data flow from keypress to render/storage/side effects across browser contexts.
2. I understand extension boundaries: page DOM vs browser APIs vs runtime messaging.
3. I can design explicit state machines for keyboard-heavy UIs.
4. I can reason about performance budgets and enforce them with instrumentation/tests.
5. I can design resilient startup/recovery behavior for async lifecycle mismatches.
6. I can ship with release guardrails: compatibility, upgrade safety, and store-policy consistency.
7. I can extend this codebase confidently and explain tradeoffs like an owner, not a passenger.

---

## Final Thought

If I can trace a feature from keypress to storage to render and back, I understand the system. If I can explain the tradeoffs, I can defend the design. If I can apply these patterns elsewhere, I've grown as an engineer.

This codebase is mine. I built it to learn, and now I can teach it.
