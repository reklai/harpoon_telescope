# Harpoon Telescope — What I Built and Why

A deep-dive into every major decision, pattern, and concept used in this browser extension. Written so I can internalize these patterns for future projects and articulate them in interviews.

---

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [Browser Extension Architecture](#browser-extension-architecture)
3. [Cross-Browser Compatibility](#cross-browser-compatibility)
4. [Shadow DOM Isolation](#shadow-dom-isolation)
5. [Keybinding System](#keybinding-system)
6. [Fuzzy Search Engine](#fuzzy-search-engine)
7. [Virtual Scrolling](#virtual-scrolling)
8. [Frecency Algorithm](#frecency-algorithm)
9. [Session Management](#session-management)
10. [Performance Patterns](#performance-patterns)
11. [State Management](#state-management)
12. [Event Handling Patterns](#event-handling-patterns)
13. [DOM Rendering Strategies](#dom-rendering-strategies)
14. [Build System](#build-system)
15. [Debugging Lessons](#debugging-lessons)
16. [Patterns Worth Reusing](#patterns-worth-reusing)

---

## The Big Picture

This extension brings two Neovim plugins to the browser:

- **Harpoon** (ThePrimeagen) — pin a small set of files/buffers and instantly jump between them. Here: pin up to 6 tabs with scroll memory.
- **Telescope** (nvim-telescope) — fuzzy find anything. Here: fuzzy search the current page's visible text with structural filters.

Plus **Frecency** — a Mozilla-coined algorithm for ranking items by a combination of frequency and recency.

The extension runs on Firefox (MV2), Chrome (MV3), and Zen (Firefox fork). Every overlay is a Shadow DOM panel injected into the active page. All keybindings are user-configurable with collision detection. There are two navigation modes: basic (arrows) and vim (adds j/k/Ctrl+U/D on top).

---

## Browser Extension Architecture

A browser extension has distinct execution contexts with different privileges:

### Background Script (`background.ts`)
- **Runs in its own context** — no access to page DOM
- **Has full browser API access** — `browser.tabs`, `browser.storage`, etc.
- **Coordinates everything** — it's the "server" that all other contexts talk to
- In MV2 (Firefox): a persistent background page
- In MV3 (Chrome): a **service worker** that can be terminated at any time

This is why `ensureHarpoonLoaded()` exists. On Chrome, if the service worker wakes up from being terminated, all in-memory state is gone. Every function that touches `harpoonList` calls `ensureHarpoonLoaded()` first to reload from `browser.storage.local` if needed.

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
```

**Key insight**: The boolean flag `harpoonLoaded` is safe because once loaded, the in-memory copy is the source of truth until the process dies. On Chrome, when the service worker terminates, `harpoonLoaded` resets to `false` because all module-level variables are re-initialized.

### Content Script (`content-script.ts`)
- **Runs on every web page** — has access to the page's DOM
- **Limited browser API access** — can use `browser.runtime.sendMessage` but not `browser.tabs`
- **Injected by the browser** according to manifest's `content_scripts` declaration
- **Shares the DOM** with the page but has its own JS execution context (page scripts can't access content script variables and vice versa)

The content script does three things:
1. **Routes messages** from background to the right handler (grep, scroll, open overlay)
2. **Handles keybindings** that can't go through `browser.commands` (Chrome's 4-command limit)
3. **Injects UI overlays** into the page via Shadow DOM

### Options Page / Popup (`options.ts`, `popup.ts`)
- Each has its own HTML page, loaded in the extension's own context
- Can use `browser.runtime.sendMessage` to talk to background
- The options page renders a keybinding editor; the popup shows the harpoon list

### Message Passing

All communication between contexts uses `browser.runtime.sendMessage()` (content/popup/options → background) and `browser.tabs.sendMessage()` (background → content). Messages are plain JSON objects with a `type` field:

```typescript
// Content script → Background
browser.runtime.sendMessage({ type: "HARPOON_ADD" });

// Background → Content script
browser.tabs.sendMessage(tabId, { type: "SET_SCROLL", scrollX: 0, scrollY: 100 });
```

The background script has a big `switch` on `m.type` that routes to the right handler. This is the standard pattern for browser extension message routing.

**Why not direct function calls?** Because these contexts run in separate OS processes. The browser serializes messages to JSON, sends them over IPC, and deserializes on the other end. You can't pass functions, DOM nodes, or circular references — only plain data.

---

## Cross-Browser Compatibility

### webextension-polyfill

Chrome uses `chrome.*` APIs with callbacks. Firefox uses `browser.*` APIs with Promises. Rather than writing both:

```typescript
// Without polyfill:
chrome.tabs.query({active: true}, (tabs) => { ... });  // Chrome
const tabs = await browser.tabs.query({active: true});   // Firefox
```

We use `webextension-polyfill`, which wraps Chrome's callback APIs to return Promises:

```typescript
import browser from "webextension-polyfill";
const tabs = await browser.tabs.query({active: true}); // Works everywhere
```

The polyfill is bundled by esbuild into each JS output file. At runtime, it detects whether it's in Chrome or Firefox and adapts.

### Dual Manifests

Firefox uses Manifest V2 (`manifest_v2.json`), Chrome uses Manifest V3 (`manifest_v3.json`). Key differences:

| Feature | MV2 (Firefox) | MV3 (Chrome) |
|---------|---------------|--------------|
| Background | `"scripts": ["background.js"]` | `"service_worker": "background.js"` |
| Commands limit | 8+ | 4 |
| API style | Promise-based | Callback (polyfilled) |
| Permissions | `"permissions"` only | Split `"permissions"` / `"host_permissions"` |

The build script copies the right manifest as `manifest.json` into `dist/`.

### Chrome's 4-Command Limit

Chrome MV3 only allows 4 entries in the `commands` manifest key. We register the most critical ones as commands (open harpoon, add tab, search page, and one slot jump). Everything else — slot jumps 1-6, cycling, frecency, vim toggle — is handled by a `document.addEventListener("keydown", ...)` in the content script.

On Firefox, where all 8+ commands can be registered, `browser.commands.onCommand` intercepts the key event before it reaches the page, so the content script's `keydown` handler never fires for those keys. No double-firing.

### CSS Differences

`caret-shape: block` is Firefox-only. Chrome silently ignores it. We set both `caret-color: #ffffff` (works everywhere) and `caret-shape: block` (Firefox bonus). This is the right approach for progressive enhancement — use the feature where available, degrade gracefully elsewhere.

---

## Shadow DOM Isolation

Every overlay (harpoon, telescope, frecency) is injected as a Shadow DOM element. Why?

### The Problem

Content scripts share the page's DOM. If we inject a `<div class="panel">` directly, the page's CSS might style it unexpectedly (`* { margin: 10px; }` or `.panel { display: none; }`). Our CSS could also leak out and break the page.

### The Solution

Shadow DOM creates an isolated DOM subtree with its own style scope:

```typescript
const host = document.createElement("div");
host.id = "ht-panel-host";
const shadow = host.attachShadow({ mode: "open" });
document.body.appendChild(host);

// Styles inside shadow don't leak out, page styles don't leak in
const style = document.createElement("style");
style.textContent = `/* our panel styles */`;
shadow.appendChild(style);
```

### Focus Trapping

Shadow DOM has quirks with focus management. `host.contains(element)` doesn't find elements inside the shadow tree — you must also check `host.shadowRoot.contains(element)`:

```typescript
host.addEventListener("focusout", (e: FocusEvent) => {
  const related = e.relatedTarget as Node | null;
  const staysInPanel =
    related &&
    (host.contains(related) || host.shadowRoot!.contains(related));
  if (!staysInPanel) {
    setTimeout(() => { host.focus(); }, 0);
  }
});
```

Without this, pressing Tab could move focus to the browser's address bar, and keyboard navigation would stop working.

### `:host` Selector

Inside Shadow DOM, `:host` targets the shadow host element itself. We use it to reset all inherited styles:

```css
:host {
  all: initial;
  font-family: 'SF Mono', ...;
}
```

`all: initial` resets every CSS property to its initial value, preventing inheritance from the page.

---

## Keybinding System

### Architecture

Keybindings are stored in `browser.storage.local` as a `KeybindingsConfig` object with three scopes:

- **global** — shortcuts that work on any page (Alt+M, Alt+F, etc.)
- **harpoon** — shortcuts inside the harpoon panel (arrows, d, w, s, l)
- **search** — shortcuts inside telescope/frecency (arrows, Enter, Tab)

Each binding stores both the current key and the default, enabling per-binding reset:

```typescript
interface KeyBinding {
  key: string;      // current: "Alt+M"
  default: string;  // original: "Alt+M"
}
```

### Key Matching

`matchesKey()` converts a KeyboardEvent into its component parts and compares:

```typescript
function matchesKey(e: KeyboardEvent, keyString: string): boolean {
  const parts = keyString.split("+");
  const key = parts[parts.length - 1];
  if (e.ctrlKey !== parts.includes("Ctrl")) return false;
  if (e.altKey !== parts.includes("Alt")) return false;
  // ... etc
  let eventKey = e.key;
  if (eventKey.length === 1) eventKey = eventKey.toUpperCase();
  return eventKey === key;
}
```

Single-character keys are uppercased (`e.key` returns `"d"` for lowercase d, but we store `"D"`). This makes matching case-insensitive for letter keys while preserving exact matching for special keys like `ArrowDown`.

### Vim Mode — Additive Aliases

Vim mode doesn't replace basic bindings — it adds aliases on top:

```typescript
const VIM_ENHANCED_ALIASES: Record<string, Record<string, string[]>> = {
  harpoon: {
    moveUp: ["k"],
    moveDown: ["j"],
  },
  search: {
    moveUp: ["k"],
    moveDown: ["j"],
    scrollPreviewUp: ["Ctrl+U"],
    scrollPreviewDown: ["Ctrl+D"],
  },
};
```

`getKeysForAction()` returns the primary key plus any vim aliases. `matchesAction()` checks all of them:

```typescript
function matchesAction(e, config, scope, action): boolean {
  const keys = getKeysForAction(config, scope, action);
  return keys.some((k) => matchesKey(e, k));
}
```

This means arrow keys always work, even in vim mode. Users who know vim get j/k as a bonus.

### Collision Detection

When the user tries to bind a key that's already used in the same scope, `checkCollision()` catches it:

```typescript
function checkCollision(config, scope, action, key): CollisionResult | null {
  for (const [act, binding] of Object.entries(scopeBindings)) {
    if (act === action) continue; // skip self
    if (binding.key === key) return { action: act, label };
  }
  return null;
}
```

Collisions are per-scope, not global. `Alt+M` in the global scope doesn't conflict with `M` in the harpoon scope because they're active in different contexts.

### Config Caching

The content script caches the keybinding config to avoid hitting storage on every keypress:

```typescript
let cachedConfig: KeybindingsConfig | null = null;

async function getConfig(): Promise<KeybindingsConfig> {
  if (!cachedConfig) {
    cachedConfig = await browser.runtime.sendMessage({ type: "GET_KEYBINDINGS" });
  }
  return cachedConfig;
}

// Invalidate on storage changes
browser.storage.onChanged.addListener((changes) => {
  if (changes.keybindings) cachedConfig = null;
});
```

`storage.onChanged` fires in all contexts (background, content scripts, options page) when any context writes to storage. This means if the user changes a keybinding in the options page, all open tabs' content scripts immediately invalidate their cache.

---

## Fuzzy Search Engine

### Algorithm: Character-by-Character Scoring

The fuzzy matcher in `grep.ts` scores each query term against each candidate string character by character. It's O(n) per candidate (single pass, no regex backtracking).

```
Query: "hdr"
Candidate: "handleDataRequest"
         h       d           r
         ^       ^           ^
Score = base + start_bonus + consecutive(none) + word_boundary(d after 'e') + distance_penalty
```

Scoring constants:
- `SCORE_BASE = 1` — per matched character
- `SCORE_CONSECUTIVE = 8` — bonus when matched chars are adjacent
- `SCORE_WORD_BOUNDARY = 10` — match after a separator (space, dash, etc.)
- `SCORE_START = 6` — match at position 0
- `PENALTY_DISTANCE = -1` — penalty per gap character between matches

These values were tuned empirically. The consecutive bonus is high to reward exact substrings. Word boundary bonus helps acronym-style queries (`hdr` matching `handleDataRequest`).

### Multi-Word Queries

Each space-separated term is scored independently:

```typescript
function fuzzyMatch(query: string, candidate: string): number | null {
  const terms = query.split(" ");
  let totalScore = 0;
  for (const term of terms) {
    const s = scoreTerm(term, candidate);
    if (s === null) return null; // ALL terms must match
    totalScore += s;
  }
  return totalScore;
}
```

Every term must match for the candidate to pass. Scores are summed. This means "api endpoint" requires both "api" AND "endpoint" to appear in the candidate.

### Pre-Lowercasing

Candidates are lowercased once at collection time and stored in `TaggedLine.lower`. The query is lowercased once at search time. This avoids calling `.toLowerCase()` on every comparison:

```typescript
interface TaggedLine {
  text: string;   // original text (for display)
  lower: string;  // pre-lowercased (for matching)
}
```

### Structural Filters

Filters narrow the candidate pool before fuzzy matching:

- `/code` — `<pre>` blocks (split into lines, tagged `[PRE]`) and standalone `<code>` (tagged `[CODE]`)
- `/headings` — `<h1>` through `<h6>`
- `/links` — `<a>` elements

Filters combine as **union**: `/code /links` searches code blocks AND links. The query text then **narrows** within that pool.

Parsing is stateless — `parseInput()` re-parses from scratch on every keystroke:

```typescript
function parseInput(raw: string): { filters: SearchFilter[]; query: string } {
  const tokens = raw.trimStart().split(/\s+/);
  const filters: SearchFilter[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (VALID_FILTERS[tokens[i]]) {
      filters.push(VALID_FILTERS[tokens[i]]);
    } else break; // first non-filter token starts the query
  }
  const query = tokens.slice(filters.length).join(" ").trim();
  return { filters, query };
}
```

Partial tokens like `/cod` never match because `VALID_FILTERS` is an exact dictionary lookup.

### Line Cache with MutationObserver

The DOM is walked once. Results are cached in a `LineCache` object:

```typescript
const cache: LineCache = {
  all: TaggedLine[] | null,
  code: TaggedLine[] | null,
  headings: TaggedLine[] | null,
  links: TaggedLine[] | null,
  observer: MutationObserver | null,
};
```

A `MutationObserver` watches for DOM changes and invalidates the cache (debounced 500ms):

```typescript
cache.observer = new MutationObserver(() => {
  if (cache.invalidateTimer) clearTimeout(cache.invalidateTimer);
  cache.invalidateTimer = setTimeout(invalidateCache, 500);
});
cache.observer.observe(document.body, {
  childList: true, subtree: true, characterData: true,
});
```

When the cache is valid, subsequent keystrokes re-filter the cached lines without re-walking the DOM. This is critical for performance — DOM traversal is expensive, but filtering an in-memory array is cheap.

### Deduplication

Results are deduplicated by text content using a `Set<string>`:

```typescript
const seen = new Set<string>();
for (const line of allLines) {
  if (seen.has(line.text)) continue;
  // ... score and collect
  seen.add(line.text);
}
```

### Early Exit

Once we collect 3x the max results (600), we stop scanning. The top 200 after sorting are returned. This prevents slowdown on huge pages where thousands of lines might match.

---

## Virtual Scrolling

Telescope results can number in the hundreds. Rendering 200+ DOM elements with event listeners would be slow. Virtual scrolling renders only what's visible.

### How It Works

1. A **sentinel div** is sized to the total height of all results (`results.length * ITEM_HEIGHT`). This creates the correct scrollbar.
2. A **results list div** is absolutely positioned inside the pane. It only contains ~25 DOM elements (viewport height / item height + buffer).
3. On scroll, we calculate which result indices are visible and re-bind the pool items to new data.

```typescript
const ITEM_HEIGHT = 28;  // px per row
const POOL_BUFFER = 5;   // extra items above/below viewport

function renderVisibleItems(): void {
  const scrollTop = resultsPane.scrollTop;
  const viewHeight = resultsPane.clientHeight;

  const newStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - POOL_BUFFER);
  const newEnd = Math.min(results.length,
    Math.ceil((scrollTop + viewHeight) / ITEM_HEIGHT) + POOL_BUFFER);

  if (newStart === vsStart && newEnd === vsEnd) return; // no change

  resultsList.style.top = `${vsStart * ITEM_HEIGHT}px`;

  for (let i = 0; i < count; i++) {
    const item = getPoolItem(i);     // reuse from pool
    bindPoolItem(item, vsStart + i); // update content
    // attach to DOM if not already there
  }
}
```

### Element Pool

Instead of creating/destroying DOM elements, we maintain a pool:

```typescript
let itemPool: HTMLElement[] = [];

function getPoolItem(poolIdx: number): HTMLElement {
  if (poolIdx < itemPool.length) return itemPool[poolIdx];
  const item = document.createElement("div");
  // ... create structure once
  itemPool.push(item);
  return item;
}
```

`bindPoolItem()` updates the content of an existing pool element for a new result index. The DOM structure (badge span, text span) is created once and reused.

### Passive Scroll Listener

The scroll listener uses `{ passive: true }` because it doesn't call `preventDefault()`:

```typescript
resultsPane.addEventListener("scroll", () => {
  if (results.length > 0) renderVisibleItems();
}, { passive: true });
```

Passive listeners tell the browser it's safe to scroll without waiting for JS to finish. This prevents scroll jank.

---

## Frecency Algorithm

Frecency = **Frequency × Recency weight**. Mozilla coined this for Firefox's URL bar.

### Time-Decay Buckets

Instead of a continuous decay function, we use discrete buckets:

```typescript
function computeFrecencyScore(entry: FrecencyEntry): number {
  const age = Date.now() - entry.lastVisit;
  let recencyWeight: number;
  if (age < 4 * MINUTE) recencyWeight = 100;
  else if (age < HOUR) recencyWeight = 70;
  else if (age < DAY) recencyWeight = 50;
  else if (age < WEEK) recencyWeight = 30;
  else recencyWeight = 10;
  return entry.visitCount * recencyWeight;
}
```

A tab visited 5 times in the last 4 minutes scores `5 * 100 = 500`. The same tab after a day scores `5 * 50 = 250`. A tab visited once a week ago scores `1 * 30 = 30`.

### Max 50 with Lowest-Score Eviction

When the map exceeds 50 entries, the lowest-scored entry is evicted:

```typescript
if (frecencyMap.size > MAX_FRECENCY_ENTRIES) {
  let lowestId: number | null = null;
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

This is O(n) per eviction. With n=50, it's negligible. A heap would be overkill here.

### Why Not LRU?

LRU (Least Recently Used) only considers recency. A tab you visited once 5 minutes ago would rank higher than a tab you visited 20 times yesterday. Frecency balances both signals — frequently visited tabs stay ranked even as they age.

---

## Session Management

### Save / Load / Delete Flow

Sessions snapshot the current harpoon list (URLs, titles, scroll positions) into `browser.storage.local`. On load, new tabs are created for each entry.

The save flow has several validation gates:
1. **Empty list** — can't save an empty harpoon
2. **Duplicate name** — case-insensitive rejection
3. **Identical content** — if the same set of URLs is already saved under another name
4. **Max 3 sessions** — prompts user to pick one to replace

### Session Restore on Startup

`browser.runtime.onStartup` fires when the browser starts:

```typescript
browser.runtime.onStartup.addListener(async () => {
  // 1. Check if sessions exist
  // 2. Clear stale harpoon (all tabIds are new after restart)
  // 3. Wait for a tab to be ready (content script injection)
  // 4. Show session restore overlay
});
```

After a browser restart, all previous tabIds are invalid. The harpoon list must be cleared. The retry logic (5 attempts, 1s apart) handles the race condition where tabs are still loading and content scripts aren't ready yet.

### View Mode State Machine

The harpoon overlay uses a view mode enum to switch between sub-views:

```typescript
type ViewMode = "harpoon" | "saveSession" | "sessionList" | "replaceSession";
```

Escape/close from session views goes **back to harpoon view**, not close the panel entirely. This is handled by `setViewMode("harpoon")` followed by `render()`.

---

## Performance Patterns

### rAF-Throttled Updates

Both telescope's preview pane and frecency's list use `requestAnimationFrame` to batch DOM updates:

```typescript
let previewRafId: number | null = null;

function schedulePreviewUpdate(): void {
  if (previewRafId !== null) return; // already scheduled
  previewRafId = requestAnimationFrame(() => {
    previewRafId = null;
    updatePreview();
  });
}
```

If the user rapidly arrows through results, this coalesces multiple preview updates into one paint. Without this, every arrow keypress would trigger an immediate DOM write + layout + paint.

### Synchronous First Render

Frecency uses rAF for subsequent renders but renders the first frame synchronously:

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

Without this, the panel opens empty for one frame (rAF fires on the next paint), then content appears — a visible flash. Synchronous first render eliminates this.

### DocumentFragment

Instead of `innerHTML = htmlString` (which destroys and recreates all children), we build a `DocumentFragment` and append it in one operation:

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
  listEl.textContent = ""; // clear
  listEl.appendChild(frag); // single DOM operation
}
```

`DocumentFragment` is not rendered — it's a lightweight container. When appended to the DOM, its children are moved (not copied) in a single operation. This avoids the "flash of empty" that innerHTML causes (clear → parse → insert).

### Class Swap for Active Highlight

Arrow key navigation doesn't rebuild the DOM. It just swaps CSS classes:

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

This is O(1) DOM work vs. O(n) for a full rebuild. The difference is noticeable when rapidly holding arrow keys.

### Direct DOM References

Instead of `querySelector(".active")` on every operation, we keep a direct reference:

```typescript
let activeItemEl: HTMLElement | null = null;
```

This avoids a DOM tree search on every arrow key press. Updated when the active item changes.

### Boolean Panel State

Instead of checking `document.getElementById("ht-panel-host")` on every keypress:

```typescript
let panelOpen = true;

function keyHandler(e: KeyboardEvent): void {
  if (!panelOpen) { ... }
}
```

`getElementById` walks the DOM. A boolean check is a single memory read.

### `will-change` for GPU Compositing

```css
.ht-backdrop {
  backdrop-filter: blur(1px);
  will-change: backdrop-filter;
}
```

`will-change` hints to the browser to promote this element to its own compositing layer. The blur effect is then handled by the GPU instead of the CPU. We keep the blur at 1px (down from 2px) to reduce GPU workload.

### String-Based escapeHtml

The original used DOM allocation:

```typescript
// Slow — creates a DOM element per call
function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
```

Replaced with a static lookup table:

```typescript
const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}
```

The DOM approach allocates a `<div>`, sets text, reads innerHTML (which triggers serialization). The string approach does a single regex pass. For a function called hundreds of times per search, this matters.

Note: `popup.ts` still uses the DOM approach — it's fine there because the popup renders a small list once, not hundreds of items per keystroke.

---

## State Management

### In-Memory + Storage

State follows a consistent pattern: load from `browser.storage.local` into an in-memory variable, mutate in memory, then persist back:

```
storage.local.get → in-memory variable → mutate → storage.local.set
```

This is the simplest approach for extension state. No Redux, no state machines, no pub/sub. The state is small (6 harpoon entries, 50 frecency entries, 3 sessions) and mutations are infrequent.

### Cache Invalidation via storage.onChanged

When any context writes to storage, `browser.storage.onChanged` fires in ALL contexts:

```typescript
browser.storage.onChanged.addListener((changes) => {
  if (changes.keybindings) cachedConfig = null;
});
```

This is how the options page's keybinding changes propagate to all open tabs' content scripts without explicit messaging. The storage layer acts as a shared bus.

### WeakRef for DOM Node References

Grep results store `WeakRef<Node>` instead of direct references:

```typescript
interface TaggedLine {
  nodeRef?: WeakRef<Node>;
}
```

`WeakRef` allows the garbage collector to reclaim the DOM node if it's removed from the page. A strong reference would keep detached DOM nodes alive in memory. When navigating to a result, we call `.deref()` — if the node was GC'd, we fall back to a full DOM walk.

---

## Event Handling Patterns

### Capture-Phase Keydown

Panel keyboard handlers use capture phase (`true` as third argument):

```typescript
document.addEventListener("keydown", keyHandler, true);
```

Capture phase fires before the page's own listeners (bubble phase). This ensures our panel intercepts keys before the page can handle them. We then call `e.stopPropagation()` to prevent the event from reaching the page.

### Event Delegation

Instead of attaching click listeners to each result item, we attach one listener to the container:

```typescript
resultsList.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest(".ht-result-item");
  if (!item) return;
  setActiveIndex(Number(item.dataset.index));
});
```

`closest()` walks up from the click target to find the nearest `.ht-result-item` ancestor. This works regardless of how many items exist or whether they're recycled (virtual scrolling). One listener vs. 200.

### mousedown preventDefault on Backdrop

```typescript
backdrop.addEventListener("mousedown", (e) => e.preventDefault());
```

Without this, clicking the backdrop would shift focus to the underlying page. `preventDefault()` on `mousedown` prevents the focus change while still allowing the `click` event (which closes the panel) to fire.

### wheel preventDefault on Preview

```typescript
previewPane.addEventListener("wheel", (e) => {
  e.preventDefault();
  previewContent.scrollTop += e.deltaY;
});
```

Without `preventDefault()`, the wheel event would bubble up and scroll the page behind the overlay. We manually scroll the preview content instead.

### Content Script Cleanup

Firefox aggressively caches content scripts. When the extension reloads during development, the old content script stays in memory alongside the new one. Both respond to messages, causing double handling.

Solution: a cleanup function stored on `window`:

```typescript
if (window.__harpoonTelescopeCleanup) {
  window.__harpoonTelescopeCleanup();
}

// ... set up listeners ...

window.__harpoonTelescopeCleanup = () => {
  document.removeEventListener("keydown", globalKeyHandler);
  document.removeEventListener("visibilitychange", visibilityHandler);
  browser.runtime.onMessage.removeListener(messageHandler);
  // ... remove injected elements ...
};
```

When the new injection runs, it calls the previous injection's cleanup function first. The old boolean guard approach (`if (window.__harpoonTelescopeInjected) return`) was wrong — it prevented NEW code from loading after an extension reload.

### Visibility Change Auto-Close

```typescript
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    const host = document.getElementById("ht-panel-host");
    if (host) host.remove();
  }
});
```

When the user switches tabs or minimizes the window, the overlay closes. This prevents stale overlays from persisting.

---

## DOM Rendering Strategies

### Full innerHTML Rebuild (Harpoon)

The harpoon panel uses `container.innerHTML = html` for full renders. This is fine because:
- The list is small (max 6 items)
- Renders are infrequent (only on user action, not typing)
- The panel is simple (no input element to preserve)

### Static Shell + Dynamic List (Frecency)

Frecency initially used full innerHTML rebuild, which destroyed the search input mid-event and broke typing. The fix: build the shell once, only update the list contents:

```typescript
// Built once in openFrecencyOverlay():
const input = document.createElement("input");
inputWrap.appendChild(input);
const listEl = document.createElement("div");
panel.appendChild(listEl);

// On filter change:
function renderList(): void {
  listEl.textContent = "";
  listEl.appendChild(buildListFragment());
}
```

The input element survives across renders because it's outside `listEl`.

### Virtual Scroll + Pool (Telescope)

Telescope uses the most sophisticated approach: a fixed pool of ~25 DOM elements that are re-bound to different data as the user scrolls. See [Virtual Scrolling](#virtual-scrolling) above.

### The Rendering Spectrum

```
Simple                                              Complex
innerHTML ←——→ DocumentFragment ←——→ Class swap ←——→ Virtual scroll
(Harpoon)      (Frecency list)     (Active highlight)  (Telescope)
```

Choose the simplest approach that meets performance requirements. Don't over-engineer.

---

## Build System

### esbuild

We use esbuild (not webpack, not rollup) because:
1. It's fast (Go-based, 10-100x faster than alternatives)
2. It bundles TypeScript directly (no intermediate tsc step)
3. Simple API — the build script is 85 lines

```javascript
const shared = {
  bundle: true,     // resolve imports into single files
  format: "iife",   // wrap in immediately-invoked function (browser compat)
  target: "es2022", // use modern JS features
  minify: false,    // readable output during development
};
```

### IIFE Format

Browser extension scripts run in the global scope. `format: "iife"` wraps the output in `(() => { ... })()`, preventing variable leakage into the global namespace.

### TypeScript Without tsc

esbuild strips types but doesn't check them. We run `tsc --noEmit` separately for type checking:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "node build.mjs"
  }
}
```

`tsconfig.json` has `"noEmit": true` — tsc is purely a type checker, never an emitter. esbuild handles all code generation.

### Static Asset Copying

The build script copies non-TS files (HTML, CSS, icons, manifest) to `dist/` using Node's `cpSync`:

```javascript
const staticFiles = [
  [`src/${manifestFile}`, "manifest.json"],
  ["src/popup/popup.html", "popup/popup.html"],
  // ...
];
```

The manifest file is selected by `--target` flag (firefox → MV2, chrome → MV3).

---

## Debugging Lessons

### The Frecency Input Destruction Bug

**Symptom**: Typing in the frecency filter broke after the first character.

**Root cause**: `render()` did `container.innerHTML = html`, which rebuilt the entire panel including the input element. After the first keystroke triggered `render()`, the input element was destroyed and replaced. The cursor disappeared, the second keystroke had no target.

**Fix**: Build the input element once outside the render cycle. Only update `listEl.textContent`.

**Lesson**: Never rebuild a parent element that contains a focused input. Separate the static shell from the dynamic content.

### The Frecency Flicker Bug

**Symptom**: Arrow key navigation in frecency caused visible flicker.

**Root cause**: `renderList()` was called on every arrow key, which cleared and rebuilt all DOM items. Even with DocumentFragment, the clear-then-append cycle caused a single frame with no items visible.

**Fix**: Separate `updateActiveHighlight()` (class swap only) from `renderList()` (full rebuild). Arrow keys only call `updateActiveHighlight()`.

**Lesson**: Distinguish between "data changed" (needs rebuild) and "selection changed" (needs class swap).

### The CSS Transition Shadow Glitch

**Symptom**: Frecency items had a ghosting/shadow effect during rapid arrow navigation.

**Root cause**: `transition: background 0.1s` on items meant the background color animated between active (blue) and inactive (transparent). During rapid class swaps, multiple items were mid-transition simultaneously, creating visual artifacts.

**Fix**: Remove the transition. Class swaps should be instant.

**Lesson**: CSS transitions on rapidly-toggled classes cause artifacts. Only use transitions on user-hover or deliberate animations.

### The Content Script Injection Guard Bug

**Symptom**: After extension reload during development, the new content script didn't inject.

**Root cause**: Old guard pattern `if (window.__harpoonTelescopeInjected) return;` prevented any subsequent injection, even of new code.

**Fix**: Use a cleanup function approach. New injection cleans up the old one, then installs itself.

**Lesson**: Guard patterns should allow replacement, not just prevent duplication.

### Firefox Content Script Caching

**Symptom**: Code changes didn't take effect after extension reload.

**Root cause**: Firefox caches content scripts aggressively. Even after reloading the extension, the old content script may persist in memory.

**Fix**: Full extension removal + re-install, or the cleanup function approach above.

**Lesson**: During Firefox extension development, sometimes you need to fully remove and re-add the extension, not just reload.

---

## Patterns Worth Reusing

### 1. Message Router Pattern
A single `switch` on `m.type` that routes to handler functions. Simple, debuggable, extensible.

### 2. Lazy-Load Guard
`ensureLoaded()` with a boolean flag. Safe to call multiple times. Essential for service workers that can terminate.

### 3. Cache + Observer Invalidation
Cache expensive computations. Use MutationObserver (or event listeners) to invalidate. Debounce invalidation to avoid churn.

### 4. Configurable Keybindings with Per-Scope Collision Detection
Store bindings as data, not code. Match at runtime. Detect conflicts within the active scope.

### 5. Additive Mode Aliases
Don't replace — add. Basic keys always work. Advanced mode layers on extra bindings.

### 6. Shadow DOM for Page-Injected UI
Prevents style leakage in both directions. Essential for any browser extension that injects UI.

### 7. DocumentFragment Batching
Build a fragment off-DOM, append in one operation. Eliminates flash-of-empty.

### 8. Direct DOM Reference Instead of querySelector
Keep a variable pointing to the active element. Update it on change. Avoid repeated tree searches.

### 9. rAF Throttle with Synchronous First Render
Defer subsequent renders to animation frames. Render the first frame synchronously to avoid initial flash.

### 10. Event Delegation with closest()
One listener on a container, use `closest()` to find the relevant item. Works with dynamic/pooled elements.

### 11. WeakRef for Optional DOM References
Store references that don't prevent garbage collection. Check with `.deref()` and fall back gracefully.

### 12. Cleanup Function on Window
For content scripts: store a cleanup function, call it before re-initializing. Handles extension reloads.

### 13. storage.onChanged as a Cross-Context Bus
Writing to `browser.storage.local` automatically notifies all contexts. No explicit messaging needed for config changes.

### 14. Progressive CSS Enhancement
Use features like `caret-shape: block` that only work in some browsers. The fallback is acceptable (standard caret). Don't polyfill — just accept graceful degradation.

### 15. Virtual Scrolling with Element Pool
Fixed-height items, a sentinel for scrollbar height, a pool of reusable DOM elements. Only render what's visible. Passive scroll listener.
