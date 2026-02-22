# Harpoon Telescope — Complete Implementation Guide

This file exists so I can grow from junior -> mid -> senior by mastering how this codebase actually works. It is a full rebuildable walkthrough, not a tutorial. It is meant to make me confident explaining every subsystem in an interview, because this product is mine and I can defend every tradeoff.

## Current Focus (System-Wide)

- Treat the product as one integrated system: search, tab manager, sessions, help, shared runtime contracts, and build/release tooling.
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
7. [Keybinding System — src/lib/common/contracts/keybindings.ts](#keybinding-system--srclibcommoncontractskeybindingsts)
8. [Content Script Boot — src/entryPoints/contentScript](#contentScript-boot--srcentryPointscontentScript)
9. [Background Process — src/entryPoints/backgroundRuntime](#background-process--srcentrypointsbackgroundruntime)
10. [Search Current Page — src/lib/ui/panels/searchCurrentPage](#search-current-page--srclibuipanelssearchcurrentpage)
11. [Search Open Tabs — src/lib/ui/panels/searchOpenTabs](#search-open-tabs--srclibuipanelssearchopentabs)
12. [Tab Manager — src/lib/ui/panels/tabManager](#tab-manager--srclibuipanelstabmanager)
13. [Session Menu — src/lib/ui/panels/sessionMenu](#session-menu--srclibuipanelssessionmenu)
14. [Help — src/lib/ui/panels/help](#help--srclibuipanelshelp)
15. [Common Layer](#common-layer)
16. [Panel Lifecycle + Guards](#panel-lifecycle--guards)
17. [Performance Patterns](#performance-patterns)
18. [UI Conventions (Footers, Navigation, Filters)](#ui-conventions-footers-navigation-filters)
19. [Patterns Worth Reusing](#patterns-worth-reusing)
20. [Maintainer Operating Mode](#maintainer-operating-mode)
21. [System Invariants](#system-invariants)
22. [Algorithm + Complexity Ledger](#algorithm--complexity-ledger)
23. [Bug Triage + Patch Runbook](#bug-triage--patch-runbook)
24. [Incident Playbooks](#incident-playbooks)
25. [Interview Prep + Codebase Walkthrough](#interview-prep--codebase-walkthrough)
26. [Final Thought](#final-thought)
27. [Algorithm Deep Dive](#algorithm-deep-dive)
28. [State Management Deep Dive](#state-management-deep-dive)
29. [Concurrency Deep Dive (JavaScript + Extension Runtime)](#concurrency-deep-dive-javascript--extension-runtime)
30. [Transferable Engineering Patterns](#transferable-engineering-patterns)
31. [Browser Primitives Deep Dive](#browser-primitives-deep-dive)
32. [DOM and Shadow DOM Internals](#dom-and-shadow-dom-internals)
33. [Dynamic UI Complexity and Control Strategies](#dynamic-ui-complexity-and-control-strategies)
34. [Inline HTML Template Strategy (How It Works + Tradeoffs)](#inline-html-template-strategy-how-it-works--tradeoffs)
35. [Grepping and Fuzzy Search System (Full Deconstruction)](#grepping-and-fuzzy-search-system-full-deconstruction)
36. [Primitive-to-Framework Mapping (React/Vue/Solid)](#primitive-to-framework-mapping-reactvuesolid)
37. [Rebuild and Direction-Change Playbooks](#rebuild-and-direction-change-playbooks)

---

## Project Overview

Harpoon Telescope is a keyboard-first browser extension inspired by Harpoon/Telescope workflows:

- Tab Manager (Harpoon): pin up to 4 tabs with scroll restore and sessions.
- Search Current Page (Telescope): fuzzy grep with structural filters + preview.
- Search Open Tabs (Frecency): ranked open tabs by frequency and recency.
- Session Menu: load/save/replace session flows with explicit confirmations.

Everything runs in plain TypeScript with no UI framework. Overlays are Shadow DOM panels injected into the active page.
Engineering promise: stay Ghostty-inspired and browser-primitive (DOM/Shadow DOM/WebExtension APIs), keep UI latency low, minimize visual glitching, and preserve Firefox/Chrome parity.

### System Interaction Map (High-Level)

Read this first before the detailed flow chapters.

```text
┌───────────────────────────────────────────────────────────────────────────────┐
│                               Browser Runtime                                │
└───────────────────────────────────────────────────────────────────────────────┘
                 │
                 │ keydown / runtime messages
                 v
┌───────────────────────────────────────────────────────────────────────────────┐
│ Content Script (src/lib/appInit/appInit.ts)                                 │
│ - Global action registry (keybinding -> action handler)                      │
│ - Overlay lifecycle guard (single panel host)                               │
│ - Page-owned operations (DOM grep, scroll capture/restore requests)         │
└───────────────────────────────────────────────────────────────────────────────┘
        │ opens overlays in Shadow DOM                 │ via runtime adapters
        v                                               v
┌────────────────────────────────┐      ┌──────────────────────────────────────┐
│ Overlay UIs (content context) │      │ Background (privileged context)      │
│ - searchCurrentPage           │<---->│ - tabManagerDomain                    │
│ - searchOpenTabs              │      │ - sessionDomain + message handlers    │
│ - tabManager                  │      │ - startupRestore lifecycle            │
│ - sessionMenu                 │      │ - command/runtime routing             │
│ - help                        │      └──────────────────────────────────────┘
└────────────────────────────────┘                       │
        │                                                │ reads/writes
        │ direct DOM rendering                           v
        │                                      ┌───────────────────────────────┐
        └------------------------------------->│ browser.storage.local          │
                                               │ - tabManagerList              │
                                               │ - tabManagerSessions          │
                                               │ - frecencyData               │
                                               │ - keybindings                │
                                               │ - storageSchemaVersion       │
                                               └───────────────────────────────┘
        │
        v
┌───────────────────────────────────────────────────────────────────────────────┐
│ Composability Layer (src/lib/core + src/lib/adapters/runtime)               │
│ - core/sessionMenu/sessionCore.ts: pure session state transitions/selectors │
│ - core/panel/panelListController.ts: shared list move/wheel/half-page math  │
│ - adapters/runtime/*: single runtime sendMessage boundary                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

How to use this map:

1. First identify the owner of the state (usually background).
2. Then locate where the event starts (content keydown or startup event).
3. Then trace request/response boundaries (runtime message edges).
4. Finally trace UI rendering boundaries (overlay local state -> DOM).

---

## Data-Flow Walkthrough (Start -> End -> Start)

This section is the heart of the file. It shows how data moves through the system so I can rebuild it from memory. Each flow is a lesson in architecture, state management, algorithms, and critical thinking.

How to naturally walk these chapters (flow-first):

1. Read one flow from trigger to side effect.
2. Extract the core concepts from that flow.
3. Identify the exact algorithmic steps used.
4. Do one no-AI rep (small change from memory, then verify in code).
5. Run the relevant tests or manual checks.
6. Explain the flow out loud in interview style.
7. Capture one lesson I can reuse in another codebase.

Flow evidence artifacts I must produce for each chapter:

1. A one-screen data-flow sketch (`trigger -> handler -> state -> render -> side effect`).
2. One invariant list (`must always hold`) and one failure-path list (`how it can break`).
3. One patch artifact (small change or fix) with proof (`typecheck/lint/test/manual repro`).
4. One tradeoff note (`why this design over alternatives`).

Flow ownership rubric (junior -> mid -> senior):

1. Junior: can trace message/event flow and name owning module for each step.
2. Mid: can change one step in the flow without breaking neighboring steps.
3. Senior: can redesign flow boundaries, defend tradeoffs, and add regression guards.

No-AI rep ladder (use on each flow):

1. Rep 1: trace-only (no edits), write flow from memory.
2. Rep 2: safe extension (new keybinding/filter/hint) with tests.
3. Rep 3: bug-fix rep (reproduce -> patch -> prove -> document invariant).
4. Rep 4: refactor rep (reduce complexity, keep behavior identical, prove with checks).

Code-review drill (flow lens):

1. Identify highest-risk edge in the flow (state transition, async boundary, or cleanup path).
2. Ask what invariant might regress.
3. Require one targeted regression check for that invariant.
4. Reject patches that add behavior without adding evidence.

Incident retrospective template (flow lens):

1. Trigger: what event started the broken path?
2. Drift point: where did expected flow diverge from actual?
3. Guard gap: what invariant/check was missing?
4. Fix: what changed in code and why this is the right layer?
5. Prevention: what test/runbook/doc update now catches this class early?

---

### Flow A — Open a Panel and Search

User presses `Alt+F` on any page. The content script's global keydown handler in `src/lib/appInit/appInit.ts` catches the event, and `matchesAction(e, config, "global", "searchInPage")` returns true. The handler calls `openSearchCurrentPage(config)` from `src/lib/ui/panels/searchCurrentPage/searchCurrentPage.ts`, which creates a Shadow DOM host (`#ht-panel-host`) and builds the search UI inside it.

The content script owns DOM access because the background cannot touch page DOM — this is a fundamental browser security boundary. Panel lifecycle is one layer of this architecture: host integrity is validated before open, and open paths fail closed (`dismissPanel()`) on sync or async initialization failures, so stale host state does not poison later feature flows.

When the user types a query, the `input` event fires and updates the closure-scoped state — `currentQuery` holds what the user typed, `activeFilters` holds structural filters like `/code` or `/headings`. Then `applyFilter()` runs `grepPage()` from `src/lib/ui/panels/searchCurrentPage/grep.ts`, which populates `results`. Finally `renderResults()` updates the DOM and `updatePreview()` shows context for the highlighted item.

This is unidirectional data flow: events mutate state, state drives render, render never mutates state. The pattern prevents bugs where UI and state diverge.

The challenge is performance. The DOM can have thousands of nodes, and scanning all of them on every keystroke would freeze the UI. All JavaScript runs on a single thread — the main thread — with no parallelism. The event loop processes one event at a time: keydown fires, the handler runs synchronously, render functions update DOM synchronously, then the browser paints. If any step takes longer than ~16ms (the budget for 60fps), the UI janks.

The solution uses several techniques. First, `grepPage()` walks the DOM once and caches the lines, invalidating on mutations with a 500ms debounce. This means stale results for up to 500ms after DOM changes, but no repeated full-DOM walks — O(n) once instead of O(n) per keystroke. Second, fuzzy scoring uses a character-by-character algorithm that iterates once per query character, avoiding regex catastrophic backtracking. Third, even if 10,000 lines match, `MAX_RESULTS` caps the list at 200, bounding rendering work. Fourth, virtual scrolling keeps only ~25 DOM nodes in the results list, recycling them as the user scrolls — O(visible) rendering instead of O(total). Fifth, expensive fields like `domContext`, `ancestorHeading`, and `href` are computed lazily in `updatePreview()`, not upfront for all 200 results.

When the user navigates with arrows (or built-in `j/k` aliases), `activeIndex` changes, `renderResults()` highlights the new item, and `updatePreview()` shows its context. When the user presses Enter, the overlay scrolls to the target element using `src/lib/common/utils/scroll.ts` and closes.

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

**Files to trace:** `src/lib/appInit/appInit.ts` (global key handler + host integrity guard), `src/lib/ui/panels/searchCurrentPage/searchCurrentPage.ts` (overlay UI + state), `src/lib/ui/panels/searchCurrentPage/grep.ts` (DOM walking + fuzzy scoring), `src/lib/common/utils/panelHost.ts` (host lifecycle + dismiss), `src/lib/common/utils/scroll.ts` (scroll-to-text).

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

The background bootstrap in `src/entryPoints/backgroundRuntime/background.ts` delegates tab-manager state to `src/lib/backgroundRuntime/domains/tabManagerDomain.ts`. That domain first calls `ensureTabManagerLoaded()` to load state from storage if needed. MV3 service workers can be killed at any time, so every stateful handler calls this guard before reads/writes — it's idempotent and safe to call repeatedly. Then the domain sends `GET_SCROLL` back to the content script to capture the current scroll position, because scroll state is page-owned and the background cannot read `window.scrollX` directly. With scroll position in hand, it creates a `TabManagerEntry`, compacts slots to keep them sequential (1, 2, 3 instead of 1, 3, 4), saves to `browser.storage.local`, and returns. The content script shows a feedback toast via `src/lib/common/utils/feedback.ts` saying "Added to Tab Manager [slot]".

Later, the user presses `Alt+1` to jump. The content script sends `{ type: "TAB_MANAGER_JUMP", slot: 1 }`. The background finds the entry and either activates the existing tab or, if it was closed, re-opens the URL in a new tab and restores scroll.

There are two open paths in the full system: page-level keydown in the content script (normal path) and browser command shortcuts routed through `src/lib/backgroundRuntime/handlers/commandRouter.ts` (command-declared actions). The command router uses bounded retries when delivering `OPEN_*` messages, and selected panel-open data fetches use retries too. This is readiness policy, not business logic: it protects all feature flows from transient context startup gaps.

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

**Files to trace:** `src/lib/appInit/appInit.ts` (keybind handler), `src/entryPoints/backgroundRuntime/background.ts` (router composition), `src/lib/backgroundRuntime/handlers/commandRouter.ts` (command delivery retries), `src/lib/backgroundRuntime/domains/tabManagerDomain.ts` (state + commands), `src/lib/backgroundRuntime/handlers/tabManagerMessageHandler.ts` (runtime API surface), `src/lib/ui/panels/tabManager/tabManager.ts` (open-list retry), `src/lib/common/utils/feedback.ts` (toast).

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

### Flow C — Session Menu (Load / Save / Confirm)

User presses `Alt+S` to open the load-session view. The content script opens `src/lib/ui/panels/sessionMenu/sessionMenu.ts`, which renders immediately with an empty list shell so the search input is responsive before async session fetch completes. Then it loads sessions from background and re-renders with the selected row + preview.

The session menu is a small state machine with explicit transient modes:

1. normal list browsing,
2. rename mode (inline input),
3. load confirmation,
4. overwrite confirmation,
5. delete confirmation.

Each mode narrows allowed key handling so the UI cannot drift into ambiguous mixed states. During confirmation, only configured confirm/cancel keys are accepted. During rename, text-edit behavior is delegated to the input, while jump/close keys still work predictably.

The load flow is two-step by design. `Enter` (tabManager jump action) first requests a slot-level load plan (`SESSION_LOAD_PLAN`), renders preview-side summary rows (`+`, `-`, `~`, `=`), and only executes `SESSION_LOAD` after explicit confirm. This prevents accidental destructive transitions and makes changes visible before commit.

Concepts to internalize from this flow:

1. **Mode-gated input handling:** key meaning depends on explicit state, not ad hoc if-branches.
2. **Plan-before-commit UX:** show the computed diff before applying load/overwrite operations.
3. **Fast-open shell rendering:** render early, hydrate async data after, keep first keystroke latency low.

Algorithm lens (step-by-step):

1. Open shell and bind handlers.
2. Fetch sessions and compute filtered indices.
3. On jump action, request load plan and render summary.
4. Apply only on confirm action.
5. Re-fetch and re-render canonical state after mutation.

Extension path (how to safely add capability):

1. Add a new session action in `keybindings.ts` (`DEFAULT_KEYBINDINGS` + labels).
2. Handle it via `matchesAction(...)` inside `session.ts`.
3. Add matching footer/help hint via `keyToDisplay(...)`.
4. Verify no mode leaks (rename/confirm/list transitions remain exclusive).

Interview articulation:

1. "I modeled session interactions as explicit transient states to keep keyboard behavior deterministic."
2. "I separated planning from execution to prevent accidental destructive loads."
3. "I kept panel-open latency low by rendering a shell before async hydration."

**Files to trace:** `src/lib/ui/panels/sessionMenu/sessionMenu.ts` (panel orchestration), `src/lib/ui/panels/sessionMenu/session.ts` (view renderers + key handlers), `src/lib/backgroundRuntime/handlers/sessionMessageHandler.ts` and `src/lib/backgroundRuntime/domains/sessionDomain.ts` (plan/load/save/rename/delete domain behavior).

Visual map (Flow C):

```text
[User Alt+S]
    |
    v
[sessionMenu.ts opens shell + binds keys]
    |
    v
sendMessage SESSION_LIST -------------------------------.
                                                       |
                                                       v
                                   [Background session handler]
                                                       |
                                                       v
<----------------------- session list ------------------'
    |
    v
[filtered list + preview]
    |
    v
[Enter/jump] -> SESSION_LOAD_PLAN -> preview summary (+,-,~,=)
    |
    v
[confirmYes] -> SESSION_LOAD
```

Practice loop (no AI, data-flow first):

1. Trace: open panel -> list fetch -> filter index computation -> preview render.
2. Trace: jump -> load plan -> confirm -> load execution.
3. Modify: add one session-local keybinding and wire footer/help labels from config.
4. Verify: rename, overwrite, delete, and confirm paths cannot overlap or freeze.

Failure drill:

1. Break one mode reset path (for example leave confirmation active after list mutation).
2. Observe stale footer/hint behavior or blocked input.
3. Restore explicit reset transitions and verify escape/close cleanup.

Growth checkpoint:

1. Junior signal: can trace one mode transition end-to-end.
2. Mid signal: can add a session action without introducing state leaks.
3. Senior signal: can simplify mode logic while preserving deterministic keyboard UX.

---

### Flow D — Session Restore on Startup

User closes the browser with tabs pinned in Tab Manager. When the browser reopens, `browser.runtime.onStartup` fires and is handled by `src/lib/backgroundRuntime/lifecycle/startupRestore.ts` (registered from `src/entryPoints/backgroundRuntime/background.ts`). Tab IDs are not stable across browser restarts — the old `tabManagerList` is useless because all those tab IDs now point to nothing. The background clears the stale list and loads `tabManagerSessions` from storage to prepare for restore.

The challenge is timing. Content scripts load asynchronously, and at startup the background is ready before any tab's content script has finished initializing. If the background immediately tries to send `SHOW_SESSION_RESTORE` to the active tab, the message fails because no listener exists yet.

The solution uses a retry loop with initial delay. The background waits 1.5 seconds after startup before even trying — this gives the browser time to load at least one tab. Then it attempts to send the message. If it fails (content script not ready), it waits 1 second and retries, up to 5 attempts. In the worst case, the restore prompt appears after ~6.5 seconds, but it reliably appears. If all retries fail, the user can still manually open Tab Manager and load a session — the feature degrades gracefully instead of breaking.

Startup is a state transition at the application level, outside any single overlay. The restore prompt is triggered from `browser.runtime.onStartup`, then sent into an active tab via retries until a content script is ready. When the user picks a session in `src/lib/ui/panels/sessionMenu/session.ts`, the overlay sends `{ type: "SESSION_LOAD", name }`. The background rebuilds `tabManagerList` from the session entries, and the user's pinned tabs are restored.

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

**Files to trace:** `src/lib/backgroundRuntime/lifecycle/startupRestore.ts` (startup handler), `src/lib/ui/panels/sessionMenu/session.ts` (session restore UI).

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
│   │   ├── adapters/
│   │   │   └── runtime/             # typed runtime boundary (all sendMessage calls)
│   │   ├── backgroundRuntime/       # privileged background runtime modules
│   │   │   ├── domains/             # tab/session/page domain logic
│   │   │   ├── handlers/            # runtime + command message handlers
│   │   │   └── lifecycle/           # startup restore + boot-time flows
│   │   ├── core/
│   │   │   ├── panel/               # shared list-navigation controller
│   │   │   └── sessionMenu/         # pure session state machine + view selectors
│   │   ├── ui/
│   │   │   ├── panels/
│   │   │   │   ├── help/            # Help overlay
│   │   │   │   ├── searchCurrentPage/ # Telescope search (current page)
│   │   │   │   ├── searchOpenTabs/  # Frecency open tabs list
│   │   │   │   ├── sessionMenu/     # Session overlays (load/save/restore)
│   │   │   │   └── tabManager/      # Tab Manager panel (slots/swap/undo/remove)
│   │   ├── common/
│   │   │   ├── contracts/           # message schemas + shared type contracts
│   │   │   └── utils/               # helpers, parsing, formatting, shared UI primitives
│   └── icons/
│       ├── icon-48.png
│       ├── icon-96.png
│       └── icon-128.png
└── dist/                            # build output
```

---

## Build System — esBuildConfig/build.mjs

The build script bundles four entry points into IIFEs and copies static assets to `dist/`:

- `src/entryPoints/backgroundRuntime/background.ts` -> `dist/background.js`
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
- `FrecencyEntry`

**Why ambient types?**

Ambient types (in `.d.ts`) are globally available without imports. This reduces boilerplate for interfaces used across 10+ files.

**Tradeoff:** No explicit imports means it's harder to trace where a type is defined. Mitigated by having one central `types.d.ts`.

---

## Keybinding System — src/lib/common/contracts/keybindings.ts

Keybinding storage and matching are centralized here:

- Stored in `browser.storage.local` and merged with defaults for forward compatibility.
- Configurable actions for global, tab manager, search, and session scopes come from one source: `DEFAULT_KEYBINDINGS`.
- Core action matching is centralized (`matchesAction`) and display labels come from `keyToDisplay`.
- Fixed behavior outside configurable scopes remains explicit in panel handlers (for example `Ctrl+D/U` half-page jumps and built-in `j/k` aliases).

**Why merge with defaults?**

When the extension updates and adds new shortcuts, users with saved keybindings won't have the new keys. `mergeWithDefaults()` overlays saved bindings onto the full default config, so new actions get their defaults.

**Why standard aliases are additive?**

Arrow keys always work. j/k are bonuses on top. Users don't need alias keys to use the extension.

---

## Content Script Boot — src/entryPoints/contentScript

Entry point `src/entryPoints/contentScript/contentScript.ts` is minimal: it calls `initApp()` in `src/lib/appInit/appInit.ts`.

`initApp()` handles:

- cleanup on extension reload (`window.__harpoonTelescopeCleanup`)
- keybinding cache + invalidation
- global action registry (panel + tab-manager actions)
- message router (`GREP`, `GET_SCROLL`, `OPEN_*`)

**Why cleanup on reload?**

Firefox caches content scripts. On extension reload, the old script stays alive. Without cleanup, you'd have duplicate event listeners. The cleanup function removes old listeners before setting up new ones.

**Why cache keybindings?**

Every keypress calls `getConfig()`. Without caching, that's an async message round-trip on every keypress — noticeable latency. The cache loads once and invalidates on storage changes.

---

## Background Process — src/entryPoints/backgroundRuntime

Background entry `src/entryPoints/backgroundRuntime/background.ts` orchestrates:

- tab manager domain (`src/lib/backgroundRuntime/domains/tabManagerDomain.ts`)
- runtime/command handlers (`src/lib/backgroundRuntime/handlers/*`)
- startup restore coordination (`src/lib/backgroundRuntime/lifecycle/startupRestore.ts`)

**Key patterns:**

- **Lazy-load guards:** `ensureTabManagerLoaded()`, `ensureFrecencyLoaded()`, and session load helpers. MV3 service workers can restart anytime, so stateful handlers call relevant guards before read/write.

- **State reconciliation:** Before returning tab manager list, query all open tabs and mark entries as `closed` if their tab ID no longer exists.

- **Domain routing:** `background.ts` stays thin; handler/domain modules keep privileged logic isolated and easier to review.
- **Retry logic:** For session restore prompt, retry sending to content script until one is ready.

---

## Search Current Page — src/lib/ui/panels/searchCurrentPage

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

## Search Open Tabs — src/lib/ui/panels/searchOpenTabs

Uses frecency scores to rank open tabs. Filtering accepts both substring and fuzzy matches, then ranks by match quality (exact -> starts-with -> substring -> fuzzy), preferring title hits first, then tighter title matches, then URL matches.

**What is frecency?**

A Mozilla-coined term: frequency + recency. Tabs visited often and recently rank higher. The formula decays over time so old visits matter less.

---

## Tab Manager — src/lib/ui/panels/tabManager

Manages pinned-tab list UI and slot operations.

- slots are compacted to 1..N
- closed tabs persist and re-open on jump
- swap mode and undo are UI-level state machines (`W` swap, `U` undo)

**Why max 4 slots?**

Opinionated design. More slots = harder to remember which is which. 4 is enough for a focused workflow.

---

## Session Menu — src/lib/ui/panels/sessionMenu

Owns session UI overlays: load list, save panel, replace picker, and startup restore UI.

- `Alt+S` opens load sessions; `Alt+Shift+S` opens save session
- sessions are stored in `tabManagerSessions` (max 4)
- load / overwrite / delete use preview-side `y/n` confirmations
- session load confirmation includes slot-level legend (`NEW (+)`, `DELETED (-)`, `REPLACED (~)`, `UNCHANGED (=)`)
- save panel previews current Tab Manager tabs under the name input
- duplicate-name save errors are inline; identical-content saves are pre-guarded with toast (`No changes to save, already saved as "<name>"`)
- session search uses `Search Sessions . . .` and `Shift+Space clear-search`
- transient state logic now flows through `src/lib/core/sessionMenu/sessionCore.ts` so mode transitions are pure/testable
- list movement behavior reuses `src/lib/core/panel/panelListController.ts` for consistency with other overlays

---

## Session Restore Overlay — src/lib/ui/panels/sessionMenu

Startup restore prompt reuses session state with a lightweight standalone overlay:

- opens only when saved sessions exist
- supports list navigation + restore/decline actions
- uses tab-manager move/jump/close bindings for consistency
- closes cleanly on confirm/decline and reports feedback toast after restore

---

## Help — src/lib/ui/panels/help

Help overlay builds sections from live keybinding config. It documents the panel controls and filters.

- includes session-specific controls (focus toggle, search focus, clear-search, load confirm/cancel)
- key labels mirror current keybinding config instead of hard-coded defaults

**Why live keybindings?**

If the user customizes shortcuts, the help menu reflects their actual bindings, not the defaults.

---

## Common Layer

- `src/lib/common/contracts/keybindings.ts`: keybinding config schema/defaults + matching helpers used across UI/background/options.
- `src/lib/common/contracts/runtimeMessages.ts`: typed message contracts for background <-> content runtime channels.
- `src/lib/common/utils/helpers.ts`: `escapeHtml`, `escapeRegex`, `buildFuzzyPattern`, `extractDomain`.
- `src/lib/common/utils/filterInput.ts`: shared slash-filter parsing used by search overlays.
- `src/lib/common/utils/panelHost.ts`: shadow host, base styles, focus trapping.
- `src/lib/common/utils/scroll.ts`: scroll-to-text highlight.
- `src/lib/common/utils/feedback.ts`: toast rendering helper.
- `src/lib/common/utils/toastMessages.ts`: standardized feedback copy builders.
- `src/lib/common/utils/perf.ts`: perf instrumentation helper.
- `src/lib/common/utils/frecencyScoring.ts`: frecency scoring + eviction.
- `src/lib/common/utils/storageMigrations.ts` + `src/lib/common/utils/storageMigrationsRuntime.ts`: storage schema upgrades.
- Session business logic now lives in `src/lib/backgroundRuntime/domains/sessionDomain.ts` (domain layer, not common layer).

## Composability Modules — src/lib/core + src/lib/adapters/runtime

- `src/lib/core/sessionMenu/sessionCore.ts`: pure session mode transitions and derived view selectors (no DOM/browser APIs)
- `src/lib/core/panel/panelListController.ts`: shared list index math for arrows, wheel, and half-page jumps
- `src/lib/adapters/runtime/runtimeClient.ts`: central runtime client with retry policy
- `src/lib/adapters/runtime/sessionApi.ts`, `tabManagerApi.ts`, `openTabsApi.ts`, `keybindingsApi.ts`: domain-level API wrappers used by overlays and popup

Why this matters for growth:

1. You can unit-test state transitions without opening UI.
2. You can change runtime transport behavior in one place.
3. You can reuse panel list behavior without copy/paste drift.

Practice loop (no AI, chapter-specific):

1. Trace one common-layer helper from caller -> helper -> returned value usage in UI/background.
2. Modify one common-layer contract in `runtimeMessages.ts` and update all call sites.
3. Verify: run lint/typecheck/tests and manually trigger the affected runtime flow.
4. Explain: defend why common-layer modules should stay minimal and stable.

Failure drill:

1. Introduce a contract mismatch between sender and receiver payload shape.
2. Observe TypeScript/runtime failure points.
3. Repair and explain why typed message contracts reduce cross-context bugs.

Growth checkpoint:

1. Junior signal: can find where a common utility is consumed.
2. Mid signal: can evolve a common contract without hidden breakage.
3. Senior signal: can decide what belongs in `common/contracts` or `common/utils` vs feature-specific modules.

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
- **Regression budgets:** `src/lib/common/utils/perfBudgets.json` keeps expected latency envelopes explicit in code review + tests.
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

## UI Conventions (Footers, Navigation, Filters)

- Footer order: nav -> secondary (list/tree) -> action (clear/del/move) -> primary (open) -> close/back
- Footer labels: uppercase key + lowercase label (ex: `D del`)
- Tab Manager action row order: `U undo` -> `W swap` -> `D del` -> `Enter jump` -> `Esc close`
- Standard aliases: `j/k` are always enabled for up/down where list navigation exists
- Clear-search: `Shift+Space` works from search/session input flows
- Search input placeholders follow `Search <Panel Name> . . .` across session load, open tabs, and current-page search

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

1. Background owns canonical browser state (`tabs`, `sessions`, frecency persistence).
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

Search/session-list invariants:

1. Query -> filter -> rank -> render pipeline is deterministic for the same input state.
2. Focus behavior is explicit (`input`, `results`, and confirmation/rename modes) and keyboard-safe.
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
| Session List Panel | Query filter + confirmation state transitions | `O(S)` filtering where `S <= 4` + preview rendering | Mode-gated keyboard behavior during rename/confirm flows | Explicit transient states + confirm/cancel action gating |
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
5. Flow C demo (90s): session-menu state machine and explicit mode transitions.
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
3. Flow C ownership proof: trace session list fetch -> render -> mode transitions; run rename/delete/load-confirm checks; implement one new session-local keybinding; explain mode-state invariants.
4. Flow D ownership proof: trace startup restore retries in `startupRestore.ts`; run startup/fallback checks; tune retry constants safely; explain eventual consistency vs synchronous assumptions.
5. Platform ownership proof: run `npm run ci`; explain what `verify:compat`, `verify:upgrade`, and `verify:store` each prevent in release risk.

30/60/90 growth track in this repo:

1. Day 1-30 (Junior -> strong junior): finish one full rep on each flow (A-D) using the artifact checklist, pass all checks locally, and ship one low-risk patch per flow.
2. Day 31-60 (Mid ramp): complete two bug-fix reps and one refactor rep across different flows, each with invariant notes + regression proof.
3. Day 61-90 (Senior trajectory): redesign one flow boundary (ownership, state, or messaging), document tradeoffs, and add one guardrail that prevents recurrence of a real failure class.

Flow-first weekly cadence (repeat):

1. Pick one flow and write trigger -> owner -> state -> render -> side-effect map from memory.
2. Run one no-AI rep and collect evidence artifacts.
3. Run one review drill on a recent patch using invariants as acceptance criteria.
4. Run one incident retrospective (real bug or simulated failure drill).
5. Summarize what changed in your mental model and what you will tighten next week.

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

---

## Algorithm Deep Dive

This section intentionally goes deeper than the normal walkthrough. It is written so you can re-implement the critical algorithms from memory and defend the tradeoffs in code review.

### 1) Fuzzy scoring internals (search in current page)

Owner files:

- `src/lib/ui/panels/searchCurrentPage/grep/grepScoring.ts`
- `src/lib/ui/panels/searchCurrentPage/grep.ts`

Core algorithm idea:

- We do not use one large regex.
- We scan candidate text character-by-character.
- We award points for useful match structure, not just containment.

Scoring components in `grepScoring.ts`:

- `SCORE_BASE`: every matched character gets base points.
- `SCORE_CONSECUTIVE`: consecutive matches are rewarded.
- `SCORE_WORD_BOUNDARY`: matching after separators gets bonus.
- `SCORE_START`: matching at index 0 gets bonus.
- `PENALTY_DISTANCE`: gaps between matches lose points.

Why this matters:

- Substring only gives binary yes/no ranking.
- This scoring gives ordering quality: tighter matches go on top.
- Complexity is linear in candidate size for each term, predictable under load.

Minimal reconstruction (same logic pattern):

```ts
function scoreTerm(term: string, candidate: string): number | null {
  if (term.length === 0) return 0;
  if (term.length > candidate.length) return null;

  let score = 0;
  let termIdx = 0;
  let prevMatchIdx = -2;

  for (let i = 0; i < candidate.length && termIdx < term.length; i++) {
    if (candidate[i] !== term[termIdx]) continue;

    score += SCORE_BASE;
    if (i === prevMatchIdx + 1) score += SCORE_CONSECUTIVE;

    if (i === 0) {
      score += SCORE_START;
    } else if (WORD_SEPARATORS.has(candidate[i - 1])) {
      score += SCORE_WORD_BOUNDARY;
    }

    if (prevMatchIdx >= 0) {
      const gap = i - prevMatchIdx - 1;
      if (gap > 0) score += gap * PENALTY_DISTANCE;
    }

    prevMatchIdx = i;
    termIdx++;
  }

  if (termIdx < term.length) return null;
  return score;
}
```

Multi-term query behavior:

- Query is split by spaces.
- Every non-empty term must match.
- Total score is sum of each term score.
- If any term misses, candidate is rejected.

Important edge behavior to remember:

- Empty term contributes 0 and is skipped.
- Candidate lowercasing happens once during line collection (`TaggedLine.lower`).
- No regex backtracking risk.

Complexity:

- Let `T` = number of terms, `C` = candidate length.
- Worst case `O(T * C)` per candidate line.
- With early exits and `MAX_RESULTS * 3` cutoff in `grep.ts`, practical runtime remains bounded.

### 2) DOM collection and caching pipeline

Owner files:

- `src/lib/ui/panels/searchCurrentPage/grep/grepCache.ts`
- `src/lib/ui/panels/searchCurrentPage/grep/grepCollectors.ts`
- `src/lib/ui/panels/searchCurrentPage/grep/grepDom.ts`

Design:

1. Build cached line sets by structural type (`all/code/headings/links/images`).
2. Invalidate with a debounced `MutationObserver`.
3. Re-filter from memory for each input update.

Why debounce invalidation:

- Pages can mutate rapidly (ads, timers, infinite scroll).
- Immediate invalidation on every mutation causes thrash.
- Debounced invalidation gives stable search responsiveness.

Collector strategy details:

- `collectAll()` handles broad text extraction.
- `collectCode()` splits `<pre>` by lines and avoids duplicate `<code>` inside `<pre>`.
- `collectLinks()` captures link text + `href`.
- `collectImages()` captures alt/title/filename fallback.
- Multi-filter request does union + dedupe by object identity.

Dedupe reasoning:

- A node can logically satisfy multiple filters.
- Without dedupe, same visible line appears twice in results.
- `Set<TaggedLine>` avoids duplicate display and ranking bias.

### 3) Preview enrichment (lazy not eager)

Owner files:

- `src/lib/ui/panels/searchCurrentPage/grep.ts`
- `src/lib/ui/panels/searchCurrentPage/grep/grepDom.ts`
- `src/lib/ui/panels/searchCurrentPage/searchCurrentPageView.ts`

Flow:

1. Result list is built cheap first (text, score, context slice).
2. On active selection, call `enrichResult(result)`.
3. Enrichment computes heavier fields only when needed:
   - DOM-aware context window
   - nearest heading
   - `href` fallback for link nodes

Why lazy:

- With 200 results, eager enrichment creates avoidable work.
- User usually previews only a small subset.
- Latency budget is spent where user focus actually is.

### 4) Virtualized list rendering in current-page search

Owner file:

- `src/lib/ui/panels/searchCurrentPage/searchCurrentPage.ts`

Key pieces:

- `ITEM_HEIGHT`, `POOL_BUFFER` from `searchCurrentPageView.ts`.
- Sentinel element sets scrollable height.
- Actual rendered nodes are pooled and recycled.
- Scroll handler is passive + rAF-throttled.

Core idea:

- Render only rows visible in viewport +/- buffer.
- Keep DOM node count roughly constant.
- Move rendered window as user scrolls.

Mental model:

- `resultsSentinel.height = totalRows * rowHeight`
- `resultsList.top = startIndex * rowHeight`
- `children.length = endIndex - startIndex`

This gives:

- Low memory churn
- Stable scroll behavior
- Better frame time under long result sets

### 5) Session list search ranking algorithm

Owner file:

- `src/lib/ui/panels/sessionMenu/sessionView.ts`

Ranking order:

1. Exact full-name match
2. Starts-with
3. Substring
4. Fuzzy-only match

Tiebreakers:

1. Shorter name first
2. Stable original index order

Why this ordering:

- Matches user expectation for named objects.
- Keeps deterministic behavior across repeated searches.

Pseudo-flow:

```ts
for each session:
  if no substring or fuzzy hit: skip
  score by exact > startsWith > contains > fuzzy
  collect (index, score, nameLen)
sort by score, then nameLen, then index
return indices
```

### 6) Selection movement algorithm (shared panel controller)

Owner file:

- `src/lib/core/panel/panelListController.ts`

The controller centralizes:

- Up/down movement
- Half-page jumps
- Wheel-driven movement

Benefit:

- Every panel shares identical selection semantics.
- Fewer keyboard behavior regressions when adding a new panel.

### 7) Runtime readiness retry algorithm

Owner files:

- `src/lib/backgroundRuntime/handlers/commandRouter.ts`
- `src/lib/backgroundRuntime/lifecycle/startupRestore.ts`

Pattern:

- Small bounded retry schedule with increasing delays.
- Catch send-message failures and retry.
- Stop after max attempts.

Why bounded retries (not infinite):

- Prevents background worker from spinning forever.
- Keeps user feedback predictable.
- Balances robustness vs battery/CPU usage.

---

## State Management Deep Dive

This section is about explicit state ownership, transition discipline, and avoiding hidden coupling.

### 1) State ownership model in this codebase

There are four practical state classes:

1. Canonical persisted state (background + storage)
   - `tabManagerList`
   - `tabManagerSessions`
   - `frecencyData`
   - `keybindings`
   - `storageSchemaVersion`

2. Runtime domain state (background memory)
   - In-memory tab manager list and pending scroll restore maps.
   - Exists for fast operations between storage syncs.

3. UI transient state (content overlay memory)
   - Current input text
   - Selected index
   - Confirmation mode flags
   - Focus target

4. Derived view state (computed every render)
   - Filtered visible indices
   - Preview model
   - Footer hints

Rule:

- If state must survive reload/startup, it belongs in storage.
- If state is only interaction-local, keep it transient in UI.
- Never duplicate canonical source of truth between contexts.

### 2) Session transient state machine

Owner files:

- `src/lib/core/sessionMenu/sessionCore.ts`
- `src/lib/ui/panels/sessionMenu/session.ts`

`sessionCore.ts` gives pure transitions/selectors for transient flags:

- rename mode
- overwrite confirmation
- delete confirmation
- load confirmation
- focus target (`filter` vs `list`)

Important property:

- Transitions are explicit and typed.
- UI handlers call transitions, then re-render.

This avoids:

- Ad-hoc boolean mutation spread across multiple handlers.
- Forgotten reset paths after async flows.

Typical transition sequence:

1. User hits overwrite key.
2. UI handler calls `startSessionOverwriteConfirmation(...)`.
3. Render shows confirmation block.
4. Confirm key triggers async `updateSession(...)`.
5. On completion or failure, `stopSessionOverwriteConfirmation(...)`.
6. Render returns to normal mode.

### 3) Render model: write state first, render second

Panels follow this pattern repeatedly:

1. Validate input + mode guard.
2. Mutate state (or dispatch state-machine transition).
3. Call `ctx.render()`.
4. Restore focus/caret explicitly when needed.

Why focus restore is explicit:

- Re-render destroys/recreates DOM nodes.
- Browser default focus retention is not enough for keyboard-first UX.

### 4) Derived state should not be stored if cheap to recompute

Examples:

- Visible session indices from query.
- Highlight regex from query terms.
- Footer text from current keybinding config + mode.

Reason:

- Derived state in storage introduces stale cache bugs.
- Recompute-on-render keeps single source truth.

### 5) Known failure modes and fixes

Failure mode: stale selected index after filtering.

- Symptom: Enter on hidden/invalid row.
- Fix in this repo: recompute visible indices each handler path and guard selection.

Failure mode: confirmation mode conflicts with rename mode.

- Symptom: key handlers trigger wrong branch.
- Fix: mutually exclusive transient-state transitions in `sessionCore.ts`.

Failure mode: focus trap mismatch after rerender.

- Symptom: keyboard seems dead because focus moved unexpectedly.
- Fix: explicit focus target (`filter` or `list`) persisted in transient state and reapplied post-render.

### 6) When to introduce a state machine vs plain object

Use a pure state machine when:

- There are more than 2 mutually exclusive interaction modes.
- Async confirmation paths can interleave.
- You need predictable transitions for testing.

Use plain object state when:

- It is simple editable data (input text, active index).
- Modes are not coupled.

This repo uses both deliberately.

### 7) State management checklist for new features

Before coding:

1. Write owner of each state field.
2. Mark persistent vs transient.
3. Define valid transitions and invalid transitions.
4. Define post-render focus behavior.

Before merge:

1. Verify every async branch clears pending mode.
2. Verify close/dismiss path resets transient state.
3. Verify keyboard behavior in every mode.

---

## Concurrency Deep Dive (JavaScript + Extension Runtime)

This section is about practical concurrency under the browser event loop and extension lifecycle.

### 1) Event loop reality used by this repo

Important queues used here:

- Macro task queue (`setTimeout`, events)
- Micro task queue (promise continuations)
- Rendering frame queue (`requestAnimationFrame`)
- Mutation observer callback queue

Consequence:

- Ordering is not "line-by-line across async".
- UI must assume callbacks may arrive after state changed.

### 2) rAF + debounce combo in current-page search

Owner file:

- `src/lib/ui/panels/searchCurrentPage/searchCurrentPage.ts`

Input flow:

1. Input event stores pending value.
2. rAF coalesces same-frame updates.
3. 200ms debounce delays grep execution.

Why both:

- rAF: prevents redundant same-frame processing.
- debounce: reduces expensive grep recompute while typing.

Race guard used:

- `panelOpen` flag checked before processing delayed work.
- If panel closed mid-flight, callback exits safely.

### 3) Preview update coalescing

Pattern:

- `previewRafId` sentinel ensures only one pending frame callback.
- Multiple navigation events in same frame merge into one preview render.

Result:

- Less layout/reflow churn.
- No preview render storm on held-down key.

### 4) Startup and command retries for content-script readiness

Owner files:

- `src/lib/backgroundRuntime/handlers/commandRouter.ts`
- `src/lib/backgroundRuntime/lifecycle/startupRestore.ts`

Race problem:

- Background may send message before content script is ready.

Solution:

- Retry with bounded delays.
- Fail safely after max attempts.

Why this belongs in infrastructure layer:

- Readiness is transport concern.
- Feature logic should not care about startup timing races.

### 5) Scroll restore token strategy (real concurrency defense)

Owner file:

- `src/lib/backgroundRuntime/domains/tabManagerDomain.ts`

Mechanism:

- `pendingScrollRestoreTokens` map stores per-tab token.
- New restore request increments sequence token.
- Async retry loop checks token each attempt.
- Stale loop exits if token changed.

This prevents:

- Older async callback overwriting newer intended state.

This is equivalent to cancellation tokens in other systems.

### 6) MV3 worker lifecycle and idempotent guards

In MV3, worker can stop and restart. In-memory state is not durable.

Protection pattern:

- Every handler calls `ensureTabManagerLoaded()` before operations.
- Multiple calls are safe (idempotent).

Why idempotent guards matter:

- You cannot assume warm process state.
- Cold-start correctness must match warm-path correctness.

### 7) Concurrency bugs to watch for in this architecture

1. Stale closure over indices after re-render.
2. Async action completes after panel close and touches detached DOM.
3. Retry loops still running after owner state changed.
4. Multiple confirmation modes active from interleaved key paths.

Mitigations already used:

- Existence guards (`if (!document.getElementById("ht-panel-host")) return`).
- Mode guards before handling keys.
- Token/sequence checks for async retries.
- Centralized cleanup registration per panel host.

### 8) Practical coding pattern for safe async UI

Use this template:

```ts
let isOpen = true;
let inflightToken = 0;

function close(): void {
  isOpen = false;
  cleanup();
}

async function doWork(): Promise<void> {
  const token = ++inflightToken;
  const data = await fetchData();
  if (!isOpen) return;
  if (token !== inflightToken) return;
  render(data);
}
```

This same pattern is applied in different forms throughout this repo.

### 9) Why this matters for frontend frameworks too

Even with React/Vue/Solid:

- event loop ordering does not disappear
- transport retries still needed
- stale async results still possible
- lifecycle cleanup still required

Frameworks change ergonomics, not physics.

---

## Transferable Engineering Patterns

These are patterns you can carry into any frontend or fullstack codebase.

### Pattern A: Canonical owner + typed boundary

- Keep one canonical owner of persisted state.
- Expose typed command/query contracts across boundaries.
- Never let presentation layers mutate canonical state directly.

Applied here:

- Background runtime owns tab/session canonical data.
- Content overlays talk through typed runtime messages.

### Pattern B: Pure state transitions for mode-heavy UIs

- Put mode transitions in pure functions.
- Keep DOM side effects in render/handler layer.
- Unit-test transition logic independently.

Applied here:

- `sessionCore.ts` transition helpers.

### Pattern C: Guardrails in CI, not memory

- Enforce architecture contracts in lint/tests.
- Enforce upgrade/store policy contracts in verify scripts.

Applied here:

- `esBuildConfig/lint.mjs` layer checks and UI contracts.
- `verify:compat`, `verify:upgrade`, `verify:store`.

### Pattern D: Defer expensive work until user intent proves needed

- Lazy enrich preview details.
- Virtualize long lists.
- Debounce expensive search computation.

Applied here:

- Search preview enrichment + virtualized result rendering.

### Pattern E: Retry policy is infrastructure, not feature logic

- Keep bounded retries in routing/adapter layers.
- Keep business logic deterministic and focused.

Applied here:

- Command router and startup restore readiness retries.

### Pattern F: Deterministic keyboard UX requires explicit focus state

- Store focus target in state.
- Re-apply focus after rerender.
- Avoid implicit focus assumptions.

Applied here:

- Session list `filter/list` focus transitions.

### Pattern G: Separate contracts from utilities

- `contracts/`: schema, types, actions, stable boundaries.
- `utils/`: parsing/formatting/helpers with no feature ownership.

Applied here:

- `src/lib/common/contracts/*`
- `src/lib/common/utils/*`

### Build-your-own exercise set (serious reps)

Exercise 1: Rebuild fuzzy scoring module from scratch.

1. Implement `scoreTerm` and `fuzzyMatch` without reading code.
2. Add unit tests for exact, prefix, boundary, and gap penalty cases.
3. Compare ranking output with current implementation.

Exercise 2: Introduce a new session confirmation mode.

1. Add new transition helpers in `sessionCore.ts`.
2. Wire render branch in session view.
3. Wire keyboard handling with exclusive mode guard.
4. Prove no mode leakage by manual matrix testing.

Exercise 3: Add new retry-protected command path.

1. Add message contract in `runtimeMessages.ts`.
2. Add background handler routing.
3. Add adapter call site.
4. Add readiness retry where delivery can race startup.

Exercise 4: Add architecture guardrail.

1. Define a new disallowed dependency edge in `lint.mjs`.
2. Write failing fixture/change.
3. Validate lint blocks it.
4. Document why this guardrail exists.

### Senior-level review prompts

When reviewing any PR, ask:

1. Which layer owns this state?
2. Did this PR add hidden coupling across layers?
3. Are async completions cancellation-safe?
4. Is cleanup deterministic on close/reload?
5. Are transitions explicit or ad-hoc booleans?
6. Is the behavior testable without opening a browser?
7. Did we preserve existing runtime/storage contracts?

If you can answer these from code, you are operating at ownership level.

---

## Browser Primitives Deep Dive

This section is the foundation layer behind everything in this project. The goal is to make you think in primitives first, then map that understanding into any framework.

### 1) What "browser primitives" means in this codebase

When this guide says "browser primitives," it means native platform APIs directly exposed by the browser runtime:

- DOM APIs (`document`, `Element`, `TreeWalker`, `MutationObserver`)
- Event system (`addEventListener`, capture/bubble phases, keyboard/mouse/focus events)
- Shadow DOM (`attachShadow`, style isolation, event retargeting)
- Rendering clock (`requestAnimationFrame`)
- Timers (`setTimeout`, debounce/retry scheduling)
- Extension APIs (`browser.runtime`, `browser.tabs`, `browser.storage.local`, `browser.commands`)

In this project, these primitives are used directly instead of a UI framework runtime.

### 2) Why this approach was chosen

Primary reasons:

1. Extension context constraints are strict.
2. Keyboard/focus behavior must be deterministic.
3. Performance must stay predictable on arbitrary pages.
4. Firefox/Chrome compatibility matters.

Direct primitives allow:

- exact control over host insertion/removal
- explicit cleanup for reload/startup edge cases
- no framework abstraction leaks around focus and event ordering

Tradeoff:

- You manually solve problems frameworks usually automate.

### 3) The primitive mindset (how to reason)

When adding/changing behavior, reason in this order:

1. Which runtime owns this data? (page DOM vs background runtime vs storage)
2. Which primitive can observe/change it safely?
3. What event starts the flow?
4. Which async boundaries can reorder work?
5. What cleanup primitive closes the lifecycle?

If you can answer those 5 questions, the implementation becomes straightforward even without a framework.

### 4) Primitive ownership map in this app

Content script (`src/lib/appInit/appInit.ts`):

- owns page-local input handling
- owns overlay DOM construction
- owns page text grep and preview rendering

Background runtime (`src/entryPoints/backgroundRuntime/background.ts` + `src/lib/backgroundRuntime/*`):

- owns canonical tab/session state mutations
- owns privileged tab operations (`browser.tabs.*`)
- owns startup/command routing

Common contracts (`src/lib/common/contracts/*`):

- defines stable message/config shapes

Common utils (`src/lib/common/utils/*`):

- provides reusable low-level helpers

### 5) What this teaches you for future frameworks

Frameworks are just structured orchestrators on top of these primitives.

- React state update -> still results in DOM operations.
- useEffect cleanup -> still maps to removing listeners/timers.
- framework router event -> still sits on browser event loop.

If you know the primitive layer, frameworks become easier to learn and debug because you understand what they are abstracting.

---

## DOM and Shadow DOM Internals

### 1) What the DOM actually is

The DOM is a mutable tree of nodes representing a document snapshot that can be read/written at runtime.

Key node types relevant here:

- `Document`: root access point
- `Element`: tagged nodes (`div`, `input`, etc.)
- `Text`: text leaf nodes used by grep traversal

This project uses both element-level and text-node-level traversal depending on task:

- element queries for structure-level UI operations
- `TreeWalker` text traversal for grep accuracy

### 2) Tree traversal strategies used here

#### Strategy A: Selector-based structural queries

Example usage:

- `querySelectorAll("h1, h2, ...")`
- `querySelectorAll("a[href]")`
- `querySelectorAll("img")`

Pros:

- concise, readable
- semantically aligned with HTML structure

Cons:

- misses unstructured text not in targeted tags

#### Strategy B: Text-node tree walking

Owner:

- `src/lib/ui/panels/searchCurrentPage/grep/grepCollectors.ts`

Pattern:

```ts
const walker = document.createTreeWalker(
  document.body,
  NodeFilter.SHOW_TEXT,
  { acceptNode(node) { ... } },
);
```

Pros:

- catches actual visible text beyond tag heuristics
- enables more complete grep

Cons:

- must filter aggressively (visibility, pre/code duplicates)
- easy to over-collect noise without careful acceptance rules

### 3) Shadow DOM internals and why it matters

Shadow DOM lets you attach an isolated subtree to a host element.

Owner utility:

- `src/lib/common/utils/panelHost.ts`

Behavior you get:

- style scoping: host page CSS does not leak into panel styles by default
- DOM encapsulation: panel internals are not in the light-DOM query path
- controlled lifecycle: one host, one cleanup path

Why extension overlays need this:

- host pages can have arbitrary CSS resets/frameworks
- without isolation, overlay UI breaks unpredictably

### 4) Event propagation details you must know

DOM events flow through:

1. capture phase (root -> target)
2. target phase
3. bubble phase (target -> root)

This repo intentionally uses capture listeners for global panel key handling so panel shortcuts can preempt page handlers when needed.

Potential pitfall:

- if you forget to stop propagation in the right branch, host page shortcuts can interfere with panel UX.

### 5) Shadow DOM event retargeting

Inside shadow trees, event targets can be retargeted to protect encapsulation.

Practical implication:

- when debugging event paths, inspect `event.composedPath()` if target behavior seems unexpected.

### 6) Layout/reflow sensitivity with dynamic panels

Any read-after-write cycles on layout-sensitive properties can trigger forced synchronous reflow.

This code mitigates that by:

- batching heavy updates via rAF
- virtualizing long lists
- minimizing DOM node churn via pooling

---

## Dynamic UI Complexity and Control Strategies

This is the hardest part of UI engineering in practice.

### 1) The core complexity problem

Dynamic UIs combine:

- mutable state
- asynchronous events
- user input timing
- rendering side effects
- focus/accessibility constraints

Each piece is manageable alone; complexity comes from interactions between them.

### 2) Typical failure classes (real-world)

1. Mode leakage: UI thinks it is in two modes at once.
2. Stale async completion: old request overwrites new intent.
3. Focus drift: keyboard stops working because focus moved unexpectedly.
4. List index drift: selected index points to filtered-out item.
5. Cleanup gaps: listeners/timers survive panel close/reload.

### 3) How this repo tackles it

#### A) Separate canonical vs transient state

- canonical in background/storage
- transient in panel runtime

#### B) Explicit mode transitions

Owner:

- `src/lib/core/sessionMenu/sessionCore.ts`

UI does not invent mode rules ad-hoc in every handler; it uses dedicated transition helpers.

#### C) Render-after-state discipline

Pattern repeated in handlers:

1. guard current mode
2. mutate state/transition
3. rerender
4. restore focus/caret if needed

#### D) Fail-closed lifecycle handling

If panel work fails:

- log context
- close panel safely
- cleanup listeners

This prevents half-broken interactive state.

### 4) Why this matters beyond this codebase

Framework or no framework, you still need:

- state ownership clarity
- explicit transition logic
- cancellation/race defense
- deterministic cleanup

Those are architecture skills, not library-specific tricks.

### 5) UI complexity checklist for every new panel

1. What are valid modes and invalid transitions?
2. Which keys should be disabled in each mode?
3. What state survives rerender?
4. What state survives close/reopen?
5. Which async operations can complete out of order?
6. What must be cleaned on close/reload?

If this checklist is weak, bugs will show up under fast typing and edge-case navigation.

---

## Inline HTML Template Strategy (How It Works + Tradeoffs)

This project often uses `container.innerHTML = ...` for rendering panel views.

### 1) How it works here

Example owners:

- `src/lib/ui/panels/searchCurrentPage/searchCurrentPage.ts`
- `src/lib/ui/panels/sessionMenu/session.ts`
- `src/lib/ui/panels/sessionMenu/sessionRestoreOverlay.ts`

Flow:

1. Build HTML string from current state.
2. Replace container content via `innerHTML`.
3. Query fresh element refs.
4. Attach listeners to fresh nodes.

### 2) Why this was chosen

Pros:

- straightforward rendering model
- no virtual DOM dependency
- very explicit output for keyboard-first overlays

Cons:

- replacing `innerHTML` destroys old nodes and listeners
- input caret/focus can reset unless manually restored
- easy to accidentally introduce XSS if interpolation is unsanitized

### 3) Mitigations used in this repo

1. Escape user/content text before interpolation (`escapeHtml`).
2. Immediately rebind listeners after rerender.
3. Preserve and restore focus/caret where required.
4. Keep higher-order state outside DOM to survive rerenders.

### 4) Complex inline HTML: how to reason about it

Complex templates become manageable when decomposed by responsibility:

- header fragment
- input fragment
- list fragment
- preview fragment
- footer fragment

That is exactly why extraction files were added:

- `searchCurrentPageView.ts`
- `sessionView.ts`

This gives composable string-render primitives while preserving current architecture.

### 5) Problems associated with string-template rendering

1. Large template literals reduce local readability.
2. Small typo can silently break structure.
3. Harder to get static type guarantees for DOM shape.
4. Re-rendering full sections can be more expensive than targeted patching.

When to keep this approach:

- moderate-size overlays
- deterministic render phases
- strong keyboard/control needs

When to consider evolving:

- very large nested UI trees
- high-frequency fine-grained local updates
- heavy component reuse requirements

---

## Grepping and Fuzzy Search System (Full Deconstruction)

This is the end-to-end "make search actually useful" pipeline.

### 1) High-level objective

Search should be:

- broad enough to find relevant content quickly
- fast enough to update while typing
- structured enough to preview context meaningfully

### 2) End-to-end data path

1. User types in panel input.
2. Input is coalesced via rAF.
3. Query execution is debounced.
4. `grepPage(query, filters)` runs.
5. Collectors provide candidate lines from cache.
6. Fuzzy scorer ranks matches.
7. Top results returned (bounded).
8. List virtualizer renders visible subset.
9. Preview lazily enriches active result.

Owners:

- `src/lib/ui/panels/searchCurrentPage/searchCurrentPage.ts`
- `src/lib/ui/panels/searchCurrentPage/grep.ts`
- `src/lib/ui/panels/searchCurrentPage/grep/*`

### 3) Why this grep is useful (not just technically correct)

Usefulness comes from combined design choices:

1. Multiple structural collectors (`code/headings/links/images/all`) make matching semantically relevant.
2. Fuzzy scoring prioritizes quality of match, not only existence.
3. Context preview shows surrounding meaning, not isolated line only.
4. DOM-aware enrichment adds heading and URL breadcrumbs.
5. Virtualization keeps interaction smooth on big result sets.

### 4) Fuzzy search: what it means here

In this repo, fuzzy search means:

- characters of query terms can match non-contiguously in candidate text
- match quality is scored by structure (start/boundary/consecutive/gap)

It is not plain levenshtein distance, and it is not plain substring.

### 5) Practical scoring interpretation

Given query `tmgr` and candidate `tab manager`:

- characters match in order
- boundary and consecutive bonuses help rank readable abbreviations higher

Given query `tab man` and candidate `my tab manager`:

- term split allows multi-token matching
- both terms must match

Given loose candidate with many gaps:

- distance penalty reduces score
- tighter candidates rise above noisy ones

### 6) Why cache + observer is essential

Without cache:

- every keystroke walks DOM from scratch
- heavy pages become unusable

With cache + mutation invalidation:

- searches run on in-memory arrays
- page changes still eventually refresh index

Tradeoff:

- small staleness window during debounce/invalidation period

That tradeoff is intentional for responsiveness.

### 7) Why preview enrichment is lazy

Computing full DOM context for every result is expensive and often wasted.

Lazy enrich strategy:

- only active result gets heavy context computation
- cached onto result object once computed

This matches actual user attention and keeps panel responsive.

### 8) How to recreate this search system from scratch

Build order (recommended):

1. implement raw text collector
2. implement simple substring filter
3. add fuzzy scoring
4. add result ranking and cap
5. add cache + invalidation
6. add structural filters
7. add lazy preview enrichment
8. add virtualization
9. add keyboard/focus controls

Each step should stay working before moving to next.

### 9) How to change search direction safely

If changing scoring behavior:

1. keep existing API shape (`grepPage`, `enrichResult`)
2. add measurement for rank shifts on known pages
3. test edge inputs (empty, very short, special chars)
4. verify preview still aligns with selected row

If changing collector behavior:

1. validate duplicates are still deduped
2. validate visibility filtering still excludes hidden noise
3. validate code/links/images tags still map to badges correctly

---

## Primitive-to-Framework Mapping (React/Vue/Solid)

Goal: make framework behavior feel obvious because you understand the primitive equivalent.

### 1) Mapping table

| Primitive-layer concept in this repo | React-style abstraction | What to remember |
|---|---|---|
| `let state; render();` in handler | `setState` + component rerender | Both are state transition then UI derivation |
| `addEventListener` + cleanup | `useEffect` return cleanup | Cleanup is not optional in either world |
| `panelOpen`/token guards | stale closure protection in async effects | Race conditions still exist under hooks |
| `innerHTML` rerender + rebind | JSX reconciliation | Reconciliation automates node diffing, not ownership semantics |
| manual focus restore | refs + effect focus management | Keyboard UX still needs explicit rules |
| runtime adapter module | service layer/hooks/query client | boundary stays valuable with or without framework |

### 2) What frameworks abstract away

- DOM diffing / patching
- component composition ergonomics
- lifecycle wiring syntax

### 3) What frameworks do NOT abstract away

- event-loop timing
- browser API ownership boundaries
- background/content cross-context contracts
- extension API constraints
- data ownership and race conditions

### 4) React mental mapping for one panel

Current primitive pattern:

1. read state vars
2. build HTML
3. attach listeners
4. mutate state in handlers
5. rerender

Equivalent React shape:

1. state hooks
2. JSX render function
3. callbacks bound in JSX
4. effects for listener/timer lifecycles
5. derived UI from current state

But underlying concerns remain identical:

- where canonical state lives
- which async operations need cancellation
- how focus is controlled after state transitions

### 5) Niche pitfalls when moving to frameworks

1. Over-centralizing state in global stores too early.
2. Ignoring extension context boundaries (background vs content).
3. Assuming framework scheduler solves logical races.
4. Losing precise keyboard/focus semantics under generic component libraries.

### 6) Foundation-first adoption strategy

When learning a new framework:

1. map each framework feature to primitive equivalent
2. ask what problem it solves and what tradeoff it introduces
3. verify where platform constraints still leak through
4. keep contracts + adapters + ownership model from this architecture

If you do this, framework learning becomes translation, not reinvention.

---

## Rebuild and Direction-Change Playbooks

This section is for ownership-level capability: rebuild from scratch, pivot architecture, or migrate frameworks without losing system clarity.

### Playbook A: Rebuild the current system from zero (primitive-first)

Phase 1: Platform scaffold

1. background entrypoint
2. content script bootstrap
3. runtime message contracts
4. build scripts and manifest wiring

Phase 2: Core interaction shell

1. panel host with shadow root
2. open/close lifecycle and cleanup registry
3. global keybinding dispatch path

Phase 3: First feature vertical (search current page)

1. input + results list
2. grep collector and ranking
3. preview pane
4. keyboard navigation
5. virtualization

Phase 4: Tab Manager vertical

1. background domain for slots
2. add/jump/remove/reorder paths
3. scroll capture/restore behavior

Phase 5: Session vertical

1. save/list/load/rename/delete domain logic
2. transient state machine for modes
3. confirmation/replace/restore overlays

Phase 6: Guardrails and tests

1. architecture lint checks
2. runtime wiring tests
3. upgrade/store/compat checks

### Playbook B: Change direction while preserving reliability

If you need to pivot feature behavior:

1. keep message contracts stable first
2. keep canonical ownership in background runtime
3. keep UI mode transitions explicit
4. migrate one panel at a time
5. run full CI between each step

### Playbook C: Migrate UI layer to a framework safely

Keep as-is:

- `src/lib/common/contracts/*`
- `src/lib/backgroundRuntime/*`
- `src/lib/adapters/runtime/*`
- build/verify guardrails

Potentially replace:

- `src/lib/ui/panels/*` rendering layer

Migration order:

1. migrate one panel behind existing adapter contracts
2. preserve keybinding semantics exactly
3. preserve focus/cleanup behavior exactly
4. compare keyboard behavior matrix before/after
5. only then migrate next panel

### Playbook D: How to know your foundation is strong

You can claim strong foundation when you can:

1. implement the same feature in vanilla primitives and in a framework
2. explain every race risk and lifecycle cleanup needed
3. identify canonical state owner without guessing
4. reason about tradeoffs before coding
5. adapt architecture without breaking contracts

### Practical mastery loop (repeat weekly)

1. pick one subsystem and redraw ownership map from memory
2. re-implement a reduced version without copying code
3. add one test that catches a realistic regression
4. explain tradeoffs and alternatives in writing
5. review one framework tutorial and translate every abstraction to primitives

If you do this long enough, you stop being framework-dependent and become system-capable.
