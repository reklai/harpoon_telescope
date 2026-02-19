// Bookmark overlay — browse, fuzzy-filter, add/remove browser bookmarks.
// Two-pane layout inspired by the search/telescope overlay:
//   Left pane (40%): bookmark results list with virtual scrolling
//   Right pane (60%): detail view or folder picker when adding
//
// Alt+B to open, type to filter, /folder and /file toggle filters,
// a to add (with folder picker), d to remove, Enter to open, Tab to
// switch panes.

import browser from "webextension-polyfill";
import { matchesAction, keyToDisplay, saveKeybindings } from "./keybindings";
import { createPanelHost, removePanelHost, getBaseStyles, vimBadgeHtml } from "./panel-host";
import { escapeHtml, escapeRegex, extractDomain } from "./helpers";
import { showFeedback } from "./feedback";

// Virtual scrolling constants
const ITEM_HEIGHT = 52;    // px per bookmark row (two lines: title + url)
const POOL_BUFFER = 5;     // extra items above/below viewport

// Valid slash-command filters for bookmarks
type BookmarkFilter = "folder" | "file";
const VALID_FILTERS: Record<string, BookmarkFilter> = {
  "/folder": "folder",
  "/file": "file",
};

/** Build a fuzzy regex from a query string (each char matches with gaps) */
function buildFuzzyPattern(query: string): RegExp | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const pattern = terms
    .map((t) =>
      t
        .split("")
        .map((c) => escapeRegex(c))
        .join("[^]*?"),
    )
    .join("[^]*?");
  try {
    return new RegExp(pattern, "i");
  } catch (_) {
    return null;
  }
}

// Folder tree node returned from background
interface BookmarkFolder {
  id: string;
  title: string;
  depth: number;
  children: BookmarkFolder[];
}

/** Flatten a folder tree into a depth-first list for rendering */
function flattenFolders(folders: BookmarkFolder[]): { id: string; title: string; depth: number }[] {
  const flat: { id: string; title: string; depth: number }[] = [];
  function walk(nodes: BookmarkFolder[]): void {
    for (const f of nodes) {
      flat.push({ id: f.id, title: f.title, depth: f.depth });
      if (f.children.length > 0) walk(f.children);
    }
  }
  walk(folders);
  return flat;
}

/** Shorten a folder path to the last 2 segments for compact display */
function shortPath(folderPath: string): string {
  const segments = folderPath.split(" \u203a ");
  return segments.length > 2
    ? segments.slice(-2).join(" \u203a ")
    : folderPath;
}

export async function openBookmarkOverlay(
  config: KeybindingsConfig,
): Promise<void> {
  try {
    const { host, shadow } = createPanelHost();
    let panelOpen = true;

    // --- Keybind display strings ---
    const upKey = keyToDisplay(config.bindings.search.moveUp.key);
    const downKey = keyToDisplay(config.bindings.search.moveDown.key);
    const switchKey = keyToDisplay(config.bindings.search.switchPane.key);
    const acceptKey = keyToDisplay(config.bindings.search.accept.key);
    const closeKey = keyToDisplay(config.bindings.search.close.key);

    const style = document.createElement("style");
    style.textContent =
      getBaseStyles() +
      `
      .ht-bookmark-container {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 80vw; max-width: 960px; height: 70vh; max-height: 640px; min-height: 280px;
        background: #1e1e1e; border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
        backface-visibility: hidden;
      }
      .ht-bookmark-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: #1e1e1e; }
      .ht-bookmark-input-wrap {
        display: flex; align-items: center; padding: 8px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06); background: #252525;
      }
      .ht-bookmark-prompt { color: #0a84ff; margin-right: 8px; font-weight: 600; font-size: 14px; }
      .ht-bookmark-input {
        flex: 1; background: transparent; border: none; outline: none;
        color: #e0e0e0; font-family: inherit; font-size: 13px;
        caret-color: #ffffff; caret-shape: block;
      }
      .ht-bookmark-input::placeholder { color: #666; }
      .ht-bookmark-columns { flex: 1; display: flex; overflow: hidden; background: #1e1e1e; }

      /* Left pane: results list */
      .ht-bm-results-pane {
        width: 40%; border-right: 1px solid rgba(255,255,255,0.06);
        overflow-y: auto; position: relative; background: #1e1e1e;
      }
      .ht-bm-results-sentinel { width: 100%; pointer-events: none; }
      .ht-bm-results-list {
        position: absolute; top: 0; left: 0; right: 0; padding: 0;
        will-change: transform;
      }
      .ht-bm-item {
        padding: 6px 10px; cursor: pointer;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        display: flex; align-items: center;
        height: ${ITEM_HEIGHT}px; box-sizing: border-box;
        outline: none; user-select: none;
      }
      .ht-bm-item:hover { background: rgba(255,255,255,0.06); }
      .ht-bm-item.active {
        background: rgba(10,132,255,0.15);
        border-left: 2px solid #0a84ff;
      }
      .ht-bm-results-pane.focused .ht-bm-item.active {
        background: rgba(255,255,255,0.13);
        border-left: 2px solid #fff;
      }
      .ht-bm-info { flex: 1; overflow: hidden; }
      .ht-bm-title {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-size: 12px; color: #e0e0e0;
      }
      .ht-bm-title mark {
        background: #f9d45c; color: #1e1e1e; border-radius: 2px; padding: 0 1px;
      }
      .ht-bm-url-line {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-size: 10px; color: #808080; margin-top: 2px;
      }
      .ht-bm-url-line mark {
        background: #f9d45c; color: #1e1e1e; border-radius: 2px; padding: 0 1px;
      }
      .ht-bm-folder-tag { color: #0a84ff; margin-right: 4px; }
      .ht-bm-folder-tag mark {
        background: #f9d45c; color: #1e1e1e; border-radius: 2px; padding: 0 1px;
      }

      /* Right pane: detail / folder picker */
      .ht-bm-detail-pane {
        width: 60%; display: flex; flex-direction: column; overflow: hidden;
        background: #1e1e1e;
      }
      .ht-bm-detail-header {
        padding: 5px 14px; font-size: 11px; color: #808080;
        background: #252525; border-bottom: 1px solid rgba(255,255,255,0.04);
        font-weight: 500; display: flex; align-items: center;
      }
      .ht-bm-detail-header-text { flex: 1; }
      .ht-bm-detail-header-close {
        display: none; cursor: pointer; color: #808080; font-size: 14px;
        line-height: 1; padding: 0 2px; border: none; background: none;
        font-family: inherit;
      }
      .ht-bm-detail-header-close:hover { color: #e0e0e0; }
      .ht-bm-detail-content {
        flex: 1; overflow-y: auto; padding: 16px 20px;
        background: #1e1e1e;
      }
      .ht-bm-detail-placeholder {
        flex: 1; display: flex; align-items: center; justify-content: center;
        color: #555; font-size: 14px; background: #1e1e1e;
      }
      .ht-bm-no-results {
        padding: 24px; text-align: center; color: #808080; font-size: 12px;
      }

      /* Detail view fields */
      .ht-bm-detail-field { margin-bottom: 14px; }
      .ht-bm-detail-label {
        font-size: 10px; color: #808080; text-transform: uppercase;
        letter-spacing: 0.5px; margin-bottom: 3px;
      }
      .ht-bm-detail-value { font-size: 12px; color: #e0e0e0; word-break: break-all; }
      .ht-bm-detail-value a { color: #0a84ff; text-decoration: none; }
      .ht-bm-detail-value a:hover { text-decoration: underline; }
      .ht-bm-detail-stats { display: flex; gap: 20px; margin-top: 8px; }
      .ht-bm-stat { display: flex; flex-direction: column; align-items: center; }
      .ht-bm-stat-value { font-size: 18px; color: #e0e0e0; font-weight: 600; }
      .ht-bm-stat-label {
        font-size: 9px; color: #808080; text-transform: uppercase;
        letter-spacing: 0.3px; margin-top: 2px;
      }

      /* Titlebar — left-aligned with filter indicators (mirrors search overlay) */
      .ht-bookmark-container .ht-titlebar-text {
        flex: 1; text-align: left; font-size: 12px; color: #e0e0e0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        display: flex; align-items: center; gap: 8px;
        margin-right: 0;
      }
      .ht-bm-title-label { flex-shrink: 0; color: #a0a0a0; }
      .ht-bm-title-sep { color: #555; flex-shrink: 0; }
      .ht-bm-title-filters { color: #808080; font-size: 11px; flex-shrink: 0; }
      .ht-bm-title-filter { color: #666; }
      .ht-bm-title-filter.active { color: #0a84ff; font-weight: 600; }
      .ht-bm-title-count { color: #808080; font-size: 11px; margin-left: auto; flex-shrink: 0; }

      /* Filter pills */
      .ht-bm-filter-pills {
        display: flex; gap: 6px; padding: 0 14px 6px; flex-wrap: wrap;
      }
      .ht-bm-filter-pill {
        display: inline-flex; align-items: center; gap: 3px;
        background: rgba(10,132,255,0.15); color: #0a84ff;
        font-size: 10px; font-weight: 600; padding: 2px 8px;
        border-radius: 10px; user-select: none;
      }
      .ht-bm-filter-pill-x {
        cursor: pointer; opacity: 0.6; font-size: 11px;
      }
      .ht-bm-filter-pill-x:hover { opacity: 1; }

      /* Tree visualization in detail pane */
      .ht-bm-tree {
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 6px;
        background: #252525;
        padding: 6px 0;
        margin-bottom: 14px;
        max-height: 160px;
        overflow-y: auto;
        font-size: 11px;
        line-height: 1.6;
      }
      .ht-bm-tree-node {
        padding: 1px 10px;
        color: #a0a0a0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-weight: 600;
      }
      .ht-bm-tree-node.active {
        color: #0a84ff;
        background: rgba(10,132,255,0.1);
      }
      .ht-bm-tree-entry {
        padding: 1px 10px;
        color: #808080;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 10px;
      }
      .ht-bm-tree-entry.active {
        color: #0a84ff;
        background: rgba(10,132,255,0.08);
        font-weight: 600;
      }
      .ht-bm-tree-domain {
        color: #555;
        margin-left: 4px;
      }
      .ht-bm-tree-node.tree-cursor,
      .ht-bm-tree-entry.tree-cursor {
        background: rgba(255,255,255,0.10);
        color: #e0e0e0;
      }
      .ht-bm-tree-node.active.tree-cursor {
        background: rgba(10,132,255,0.18);
        color: #0a84ff;
      }
      .ht-bm-tree-entry.active.tree-cursor {
        background: rgba(10,132,255,0.15);
        color: #0a84ff;
      }
      .ht-bm-tree-collapse {
        color: #555;
        font-size: 9px;
        margin-right: 3px;
      }
      .ht-bm-tree-label { font-size: 11px; }

      /* Move mode folder list in detail pane */
      .ht-bm-move-list {
        overflow-y: auto; padding: 4px 0;
      }
      .ht-bm-move-item {
        padding: 6px 14px; cursor: pointer; font-size: 12px;
        color: #e0e0e0; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; outline: none; user-select: none;
      }
      .ht-bm-move-item:hover { background: rgba(255,255,255,0.06); }
      .ht-bm-move-item.active {
        background: rgba(10,132,255,0.15);
        border-left: 2px solid #0a84ff;
      }

      /* Confirm dialog in detail pane */
      .ht-bm-confirm {
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; height: 100%; gap: 16px; padding: 20px;
      }
      .ht-bm-confirm-icon { font-size: 28px; }
      .ht-bm-confirm-msg {
        font-size: 13px; color: #e0e0e0; text-align: center;
        line-height: 1.6; max-width: 280px;
      }
      .ht-bm-confirm-title {
        color: #fff; font-weight: 600;
      }
      .ht-bm-confirm-path {
        font-size: 11px; color: #808080; margin-top: 2px;
      }
      .ht-bm-confirm-arrow {
        display: flex; align-items: center; justify-content: center; gap: 10px;
        font-size: 13px; color: #808080; margin-top: 8px; width: 100%;
      }
      .ht-bm-confirm-from { color: #808080; text-align: right; flex: 1; }
      .ht-bm-confirm-to { color: #0a84ff; font-weight: 600; text-align: left; flex: 1; }
      .ht-bm-confirm-hint {
        font-size: 11px; color: #555;
      }
    `;
    shadow.appendChild(style);

    // --- Build static shell ---
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div class="ht-backdrop"></div>
      <div class="ht-bookmark-container">
        <div class="ht-titlebar">
          <div class="ht-traffic-lights">
            <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
          </div>
          <span class="ht-titlebar-text">
            <span class="ht-bm-title-label">Bookmarks</span>
            <span class="ht-bm-title-sep">|</span>
            <span class="ht-bm-title-filters">Filters:
              <span class="ht-bm-title-filter" data-filter="folder">/folder</span>
              <span class="ht-bm-title-filter" data-filter="file">/file</span>
            </span>
            <span class="ht-bm-title-count"></span>
          </span>
          ${vimBadgeHtml(config)}
        </div>
        <div class="ht-bookmark-body">
          <div class="ht-bookmark-input-wrap">
            <span class="ht-bookmark-prompt">&gt;</span>
            <input type="text" class="ht-bookmark-input" placeholder="Filter bookmarks..." />
          </div>
          <div class="ht-bm-filter-pills"></div>
          <div class="ht-bookmark-columns">
            <div class="ht-bm-results-pane">
              <div class="ht-bm-results-sentinel"></div>
              <div class="ht-bm-results-list"></div>
            </div>
            <div class="ht-bm-detail-pane">
              <div class="ht-bm-detail-header"><span class="ht-bm-detail-header-text">Details</span><button class="ht-bm-detail-header-close" title="Back">&times;</button></div>
              <div class="ht-bm-detail-placeholder">Select a bookmark</div>
              <div class="ht-bm-detail-content" style="display:none;"></div>
            </div>
          </div>
          <div class="ht-footer">
            <div class="ht-footer-row">
              <span>j/k (vim) ${upKey}/${downKey} nav</span>
              <span>${switchKey} list</span>
              <span>${acceptKey} open</span>
              <span>${closeKey} close</span>
            </div>
            <div class="ht-footer-row">
              <span>t tree (toggle)</span>
              <span>m move</span>
              <span>d remove</span>
            </div>
          </div>
        </div>
      </div>
    `;
    shadow.appendChild(wrapper);

    // --- DOM refs ---
    const input = shadow.querySelector(".ht-bookmark-input") as HTMLInputElement;
    const resultsList = shadow.querySelector(".ht-bm-results-list") as HTMLElement;
    const resultsSentinel = shadow.querySelector(".ht-bm-results-sentinel") as HTMLElement;
    const resultsPane = shadow.querySelector(".ht-bm-results-pane") as HTMLElement;
    const detailHeader = shadow.querySelector(".ht-bm-detail-header-text") as HTMLElement;
    const detailHeaderClose = shadow.querySelector(".ht-bm-detail-header-close") as HTMLElement;
    const detailPlaceholder = shadow.querySelector(".ht-bm-detail-placeholder") as HTMLElement;
    const detailContent = shadow.querySelector(".ht-bm-detail-content") as HTMLElement;
    const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;
    const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
    const titleFilterSpans = shadow.querySelectorAll(".ht-bm-title-filter") as NodeListOf<HTMLElement>;
    const titleCount = shadow.querySelector(".ht-bm-title-count") as HTMLElement;
    const filterPills = shadow.querySelector(".ht-bm-filter-pills") as HTMLElement;
    const footerEl = shadow.querySelector(".ht-footer") as HTMLElement;

    // --- State ---
    let allEntries: BookmarkEntry[] = [];
    let filtered: BookmarkEntry[] = [];
    let activeIndex = 0;
    let activeItemEl: HTMLElement | null = null;
    let focusedPane: "input" | "results" = "input";

    function setFocusedPane(pane: "input" | "results"): void {
      focusedPane = pane;
      resultsPane.classList.toggle("focused", pane === "results");
    }
    let activeFilters: BookmarkFilter[] = [];
    let currentQuery = "";

    // Virtual scrolling state
    let vsStart = 0;
    let vsEnd = 0;
    let itemPool: HTMLElement[] = [];

    // Highlight regex (rebuilt on query change)
    let highlightRegex: RegExp | null = null;

    // rAF throttle for detail updates
    let detailRafId: number | null = null;

    // Folder tree for tree visualization and move feature
    let folderTree: BookmarkFolder[] = [];
    let flatFolderList: { id: string; title: string; depth: number }[] = [];
    let detailMode: "detail" | "move" | "tree" | "confirmDelete" | "confirmMove" = "detail";
    let moveFolders: { id: string; title: string; depth: number }[] = [];
    let moveTargetIndex = 0;
    let pendingDeleteEntry: BookmarkEntry | null = null;
    let pendingMoveEntry: BookmarkEntry | null = null;
    let pendingMoveParentId: string | null = null;

    // Tree navigation state
    let treeCursorIndex = 0;
    let treeCollapsed = new Set<string>(); // collapsed folder IDs
    let treeVisibleItems: { type: "folder" | "entry"; id: string }[] = [];
    let pendingTreeOpenEntry: BookmarkEntry | null = null;

    function close(): void {
      panelOpen = false;
      document.removeEventListener("keydown", keyHandler, true);
      if (detailRafId !== null) cancelAnimationFrame(detailRafId);
      removePanelHost();
    }

    // --- Input parsing (mirrors search overlay pattern) ---
    function parseInput(raw: string): { filters: BookmarkFilter[]; query: string } {
      const tokens = raw.trimStart().split(/\s+/);
      const filters: BookmarkFilter[] = [];
      let queryStart = 0;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (VALID_FILTERS[token]) {
          const filter = VALID_FILTERS[token];
          if (!filters.includes(filter)) filters.push(filter);
          queryStart = i + 1;
        } else {
          break;
        }
      }
      const query = tokens.slice(queryStart).join(" ").trim();
      return { filters, query };
    }

    // --- Title bar updates ---
    function updateTitle(): void {
      titleFilterSpans.forEach((span) => {
        const filter = span.dataset.filter as BookmarkFilter;
        span.classList.toggle("active", activeFilters.includes(filter));
      });
      titleCount.textContent = filtered.length > 0
        ? `${filtered.length} bookmark${filtered.length !== 1 ? "s" : ""}`
        : "";
    }

    // --- Filter pills ---
    function updateFilterPills(): void {
      if (activeFilters.length === 0) {
        filterPills.style.display = "none";
        return;
      }
      filterPills.style.display = "flex";
      filterPills.innerHTML = activeFilters.map((f) =>
        `<span class="ht-bm-filter-pill" data-filter="${f}">/${f}<span class="ht-bm-filter-pill-x">\u00d7</span></span>`
      ).join("");
      // Click x to remove a filter from the input
      filterPills.querySelectorAll(".ht-bm-filter-pill-x").forEach((x) => {
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          const pill = (x as HTMLElement).parentElement!;
          const filter = pill.dataset.filter!;
          // Remove this filter's slash command from the input
          const tokens = input.value.trimStart().split(/\s+/);
          const remaining = tokens.filter((t) => t !== `/${filter}`);
          input.value = remaining.join(" ");
          input.dispatchEvent(new Event("input"));
          input.focus();
        });
      });
    }

    // --- Highlight ---
    function buildHighlightRegex(): void {
      if (!currentQuery) { highlightRegex = null; return; }
      try {
        const terms = currentQuery.split(/\s+/).filter(Boolean);
        const pattern = terms.map((t) => `(${escapeRegex(escapeHtml(t))})`).join("|");
        highlightRegex = new RegExp(pattern, "gi");
      } catch (_) { highlightRegex = null; }
    }

    function highlightMatch(text: string): string {
      const escaped = escapeHtml(text);
      if (!highlightRegex) return escaped;
      return escaped.replace(highlightRegex, "<mark>$1</mark>");
    }

    // --- Virtual scrolling ---
    function getPoolItem(poolIdx: number): HTMLElement {
      if (poolIdx < itemPool.length) return itemPool[poolIdx];
      const item = document.createElement("div");
      item.className = "ht-bm-item";
      item.tabIndex = -1;

      const info = document.createElement("div");
      info.className = "ht-bm-info";
      const title = document.createElement("div");
      title.className = "ht-bm-title";
      const urlLine = document.createElement("div");
      urlLine.className = "ht-bm-url-line";
      info.appendChild(title);
      info.appendChild(urlLine);
      item.appendChild(info);

      itemPool.push(item);
      return item;
    }

    function bindPoolItem(item: HTMLElement, resultIdx: number): void {
      const entry = filtered[resultIdx];
      item.dataset.index = String(resultIdx);

      // Info
      const info = item.firstElementChild as HTMLElement;
      const titleEl = info.firstElementChild as HTMLElement;
      titleEl.innerHTML = highlightMatch(entry.title || "Untitled");

      const urlEl = info.lastElementChild as HTMLElement;
      const pathDisplay = entry.folderPath ? shortPath(entry.folderPath) : "";
      if (pathDisplay) {
        urlEl.innerHTML = `<span class="ht-bm-folder-tag">${highlightMatch(pathDisplay)}</span>`;
      } else {
        urlEl.textContent = "\u2013"; // dash for bookmarks with no folder path
      }

      // Active state
      if (resultIdx === activeIndex) {
        item.classList.add("active");
        activeItemEl = item;
      } else {
        item.classList.remove("active");
      }
    }

    function renderVisibleItems(): void {
      const scrollTop = resultsPane.scrollTop;
      const viewHeight = resultsPane.clientHeight;

      const newStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - POOL_BUFFER);
      const newEnd = Math.min(filtered.length,
        Math.ceil((scrollTop + viewHeight) / ITEM_HEIGHT) + POOL_BUFFER);

      if (newStart === vsStart && newEnd === vsEnd) return;
      vsStart = newStart;
      vsEnd = newEnd;

      resultsList.style.top = `${vsStart * ITEM_HEIGHT}px`;

      const count = vsEnd - vsStart;
      while (resultsList.children.length > count) {
        resultsList.removeChild(resultsList.lastChild!);
      }

      activeItemEl = null;
      for (let i = 0; i < count; i++) {
        const item = getPoolItem(i);
        bindPoolItem(item, vsStart + i);
        if (i < resultsList.children.length) {
          if (resultsList.children[i] !== item) {
            resultsList.replaceChild(item, resultsList.children[i]);
          }
        } else {
          resultsList.appendChild(item);
        }
      }
    }

    function renderResults(): void {
      buildHighlightRegex();
      updateTitle();

      if (filtered.length === 0) {
        resultsSentinel.style.height = "0px";
        resultsList.style.top = "0px";
        resultsList.textContent = "";
        resultsList.innerHTML = `<div class="ht-bm-no-results">${
          currentQuery || activeFilters.length > 0 ? "No matching bookmarks" : "No bookmarks found"
        }</div>`;
        activeItemEl = null;
        vsStart = 0;
        vsEnd = 0;
        showDetailPlaceholder(true);
        return;
      }

      resultsSentinel.style.height = `${filtered.length * ITEM_HEIGHT}px`;
      resultsPane.scrollTop = 0;
      vsStart = -1;
      vsEnd = -1;
      renderVisibleItems();
      scheduleDetailUpdate();
    }

    // Scroll listener for virtual scrolling
    resultsPane.addEventListener("scroll", () => {
      if (filtered.length > 0) renderVisibleItems();
    }, { passive: true });

    function setActiveIndex(newIndex: number): void {
      if (newIndex < 0 || newIndex >= filtered.length) return;
      if (newIndex === activeIndex && activeItemEl) {
        scheduleDetailUpdate();
        return;
      }
      if (activeItemEl) activeItemEl.classList.remove("active");
      activeIndex = newIndex;

      activeItemEl = null;
      if (newIndex >= vsStart && newIndex < vsEnd) {
        const poolIdx = newIndex - vsStart;
        const el = resultsList.children[poolIdx] as HTMLElement | undefined;
        if (el) {
          el.classList.add("active");
          activeItemEl = el;
        }
      }

      scrollActiveIntoView();
      scheduleDetailUpdate();
    }

    function scrollActiveIntoView(): void {
      const itemTop = activeIndex * ITEM_HEIGHT;
      const itemBottom = itemTop + ITEM_HEIGHT;
      const scrollTop = resultsPane.scrollTop;
      const viewHeight = resultsPane.clientHeight;

      if (itemTop < scrollTop) {
        resultsPane.scrollTop = itemTop;
      } else if (itemBottom > scrollTop + viewHeight) {
        resultsPane.scrollTop = itemBottom - viewHeight;
      }
    }

    // --- Detail pane ---
    function showDetailPlaceholder(show: boolean): void {
      detailPlaceholder.style.display = show ? "flex" : "none";
      detailContent.style.display = show ? "none" : "block";
    }

    function scheduleDetailUpdate(): void {
      if (detailRafId !== null) return;
      detailRafId = requestAnimationFrame(() => {
        detailRafId = null;
        updateDetail();
      });
    }

    function updateDetail(): void {
      if (detailMode === "move") return; // don't interfere with move view
      if (detailMode === "confirmDelete") return; // don't interfere with confirm view
      if (detailMode === "confirmMove") return; // don't interfere with confirm view
      if (detailMode === "tree") { renderTreeView(); return; } // tree mode handles its own rendering

      if (filtered.length === 0 || !filtered[activeIndex]) {
        detailHeader.textContent = "Details";
        showDetailPlaceholder(true);
        return;
      }

      const entry = filtered[activeIndex];
      detailHeader.textContent = "Details";
      showDetailPlaceholder(false);

      let html = "";

      // Title
      html += `<div class="ht-bm-detail-field">
        <div class="ht-bm-detail-label">Title</div>
        <div class="ht-bm-detail-value">${escapeHtml(entry.title || "Untitled")}</div>
      </div>`;

      // URL
      html += `<div class="ht-bm-detail-field">
        <div class="ht-bm-detail-label">URL</div>
        <div class="ht-bm-detail-value"><a href="${escapeHtml(entry.url)}" target="_blank">${escapeHtml(entry.url)}</a></div>
      </div>`;

      // Folder path (breadcrumb)
      if (entry.folderPath) {
        html += `<div class="ht-bm-detail-field">
          <div class="ht-bm-detail-label">Path</div>
          <div class="ht-bm-detail-value" style="color:#0a84ff;">${escapeHtml(entry.folderPath)}</div>
        </div>`;
      }

      // Date Added
      if (entry.dateAdded) {
        const date = new Date(entry.dateAdded);
        html += `<div class="ht-bm-detail-field">
          <div class="ht-bm-detail-label">Added</div>
          <div class="ht-bm-detail-value">${escapeHtml(date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }))}</div>
        </div>`;
      }

      // Usage stats
      html += `<div class="ht-bm-detail-stats">
        <div class="ht-bm-stat">
          <span class="ht-bm-stat-value">${entry.usageScore || 0}</span>
          <span class="ht-bm-stat-label">Score</span>
        </div>
        <div class="ht-bm-stat">
          <span class="ht-bm-stat-value">${escapeHtml(extractDomain(entry.url))}</span>
          <span class="ht-bm-stat-label">Domain</span>
        </div>
      </div>`;

      detailContent.innerHTML = html;
    }

    // --- Filtering ---
    // With no filters active: fuzzy-match query against title + url + parentTitle
    // With /folder active: fuzzy-match query against parentTitle only
    // With /file active: fuzzy-match query against url only
    // With both active: fuzzy-match query against parentTitle OR url (union)
    function applyFilter(): void {
      let results = [...allEntries];

      if (currentQuery.trim()) {
        const re = buildFuzzyPattern(currentQuery);
        if (re) {
          if (activeFilters.length === 0) {
            // No filters — match against all fields
            results = results.filter(
              (e) => re.test(e.title) || re.test(e.url) || (e.folderPath && re.test(e.folderPath)),
            );
          } else {
            // Filter-scoped matching
            results = results.filter((e) => {
              if (activeFilters.includes("folder") && e.folderPath && re.test(e.folderPath)) return true;
              if (activeFilters.includes("file") && re.test(e.url)) return true;
              return false;
            });
          }
        }
      } else if (activeFilters.length > 0) {
        // Filters active but no query — show all bookmarks that have the relevant field
        if (activeFilters.length === 1 && activeFilters[0] === "folder") {
          results = results.filter((e) => !!e.folderPath);
        }
        // /file alone with no query shows everything (all bookmarks have a URL)
      }

      filtered = results;
      activeIndex = Math.min(activeIndex, Math.max(filtered.length - 1, 0));
    }

    // --- Actions ---
    async function openBookmark(entry: BookmarkEntry): Promise<void> {
      if (!entry) return;
      close();
      await browser.runtime.sendMessage({
        type: "OPEN_BOOKMARK_TAB",
        url: entry.url,
      });
    }

    async function removeSelectedBookmark(): Promise<void> {
      const entry = filtered[activeIndex];
      if (!entry) return;
      const result = (await browser.runtime.sendMessage({
        type: "BOOKMARK_REMOVE",
        id: entry.id,
        url: entry.url,
      })) as { ok: boolean };
      if (result.ok) {
        showFeedback(`Removed: ${entry.title || entry.url}`);
        allEntries = allEntries.filter((e) => e.id !== entry.id);
        applyFilter();
        renderResults();
      } else {
        showFeedback("Failed to remove bookmark");
      }
    }

    // --- Move mode (folder picker in detail pane) ---
    function renderMoveView(): void {
      const entry = filtered[activeIndex];
      detailHeader.textContent = `Move: ${entry?.title || "bookmark"}`;
      showDetailPlaceholder(false);

      let html = '<div class="ht-bm-move-list">';
      for (let i = 0; i < moveFolders.length; i++) {
        const f = moveFolders[i];
        const indent = (f.depth - 1) * 16;
        const isActive = moveTargetIndex === i;
        html += `<div class="ht-bm-move-item${isActive ? ' active' : ''}" data-midx="${i}" style="padding-left:${14 + indent}px">`;
        html += `\u{1F4C1} ${escapeHtml(f.title)}`;
        html += '</div>';
      }
      html += '</div>';
      detailContent.innerHTML = html;

      // Click handler (event delegation)
      const list = detailContent.querySelector(".ht-bm-move-list");
      if (list) {
        list.addEventListener("click", (e) => {
          const item = (e.target as HTMLElement).closest("[data-midx]") as HTMLElement;
          if (!item) return;
          moveTargetIndex = parseInt(item.dataset.midx!);
          const entry = filtered[activeIndex];
          if (!entry) return;
          pendingMoveEntry = entry;
          pendingMoveParentId = moveFolders[moveTargetIndex]?.id || null;
          detailMode = "confirmMove";
          renderMoveConfirm();
          updateFooter();
        });
      }

      // Scroll active into view
      const activeEl = detailContent.querySelector('.ht-bm-move-item.active');
      if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    }

    async function confirmMove(): Promise<void> {
      const entry = filtered[activeIndex];
      if (!entry) return;
      const parentId = moveFolders[moveTargetIndex]?.id;
      if (!parentId) return;

      const result = (await browser.runtime.sendMessage({
        type: "BOOKMARK_MOVE",
        id: entry.id,
        parentId,
      })) as { ok: boolean };

      if (result.ok) {
        const destLabel = moveFolders[moveTargetIndex]?.title || "folder";
        showFeedback(`Moved to: ${destLabel}`);
        // Refresh bookmark list to reflect new folder path
        allEntries = (await browser.runtime.sendMessage({
          type: "BOOKMARK_LIST",
        })) as BookmarkEntry[];
        applyFilter();
        renderResults();
      } else {
        showFeedback("Failed to move bookmark");
      }
      detailMode = "detail";
      scheduleDetailUpdate();
      updateFooter();
    }

    // --- Tree view (full-pane folder/bookmark tree, toggled by `t`) ---
    function renderTreeView(): void {
      const entry = filtered[activeIndex];
      detailHeader.textContent = "Bookmark Tree";
      showDetailPlaceholder(false);

      // Group all bookmarks by parentId for quick lookup
      const byParent = new Map<string, BookmarkEntry[]>();
      for (const bm of allEntries) {
        if (!bm.parentId) continue;
        let list = byParent.get(bm.parentId);
        if (!list) { list = []; byParent.set(bm.parentId, list); }
        list.push(bm);
      }

      // Build visible items list and HTML
      treeVisibleItems = [];
      let idx = 0;
      let html = '<div class="ht-bm-tree" style="max-height:none; border:none; border-radius:0; margin:0; padding:8px 0;">';
      for (const f of flatFolderList) {
        if (f.depth === 0) continue; // skip invisible root
        const folderIsActive = entry && f.id === entry.parentId;
        const indent = (f.depth - 1) * 14;
        const collapsed = treeCollapsed.has(f.id);
        const children = byParent.get(f.id);
        const count = children ? children.length : 0;
        const hasChildren = count > 0;
        const arrow = hasChildren ? (collapsed ? '\u25B6' : '\u25BC') : '\u00A0\u00A0';
        const isCursor = idx === treeCursorIndex;

        treeVisibleItems.push({ type: "folder", id: f.id });
        html += `<div class="ht-bm-tree-node${folderIsActive ? ' active' : ''}${isCursor ? ' tree-cursor' : ''}" data-tree-idx="${idx}" style="padding-left:${10 + indent}px">`;
        html += `<span class="ht-bm-tree-collapse">${arrow}</span> \u{1F4C1} ${escapeHtml(f.title)}${count > 0 ? ` (${count})` : ''}`;
        html += '</div>';
        idx++;

        // Bookmark entries under this folder (hidden if collapsed)
        if (children && !collapsed) {
          const entryIndent = indent + 14;
          for (const bm of children) {
            const isActive = entry && bm.id === entry.id;
            const domain = extractDomain(bm.url);
            const title = bm.title || "Untitled";
            const isCur = idx === treeCursorIndex;

            treeVisibleItems.push({ type: "entry", id: bm.id });
            html += `<div class="ht-bm-tree-entry${isActive ? ' active' : ''}${isCur ? ' tree-cursor' : ''}" data-tree-idx="${idx}" style="padding-left:${10 + entryIndent}px">`;
            html += `\u{1F4C4} ${escapeHtml(title)}<span class="ht-bm-tree-domain">\u00b7 ${escapeHtml(domain)}</span>`;
            html += '</div>';
            idx++;
          }
        }
      }
      html += '</div>';
      detailContent.innerHTML = html;

      // Clamp cursor
      if (treeCursorIndex >= treeVisibleItems.length) {
        treeCursorIndex = Math.max(0, treeVisibleItems.length - 1);
      }

      // Auto-scroll cursor into view
      const cursorEl = detailContent.querySelector('.tree-cursor') as HTMLElement;
      if (cursorEl) {
        cursorEl.scrollIntoView({ block: 'nearest' });
      }
    }

    function moveTreeCursor(delta: number): void {
      if (treeVisibleItems.length === 0) return;
      const oldIdx = treeCursorIndex;
      treeCursorIndex = Math.max(0, Math.min(treeVisibleItems.length - 1, treeCursorIndex + delta));
      if (treeCursorIndex === oldIdx) return;

      const tree = detailContent.querySelector('.ht-bm-tree') as HTMLElement;
      if (!tree) return;

      const oldEl = tree.querySelector(`[data-tree-idx="${oldIdx}"]`) as HTMLElement;
      const newEl = tree.querySelector(`[data-tree-idx="${treeCursorIndex}"]`) as HTMLElement;
      if (oldEl) oldEl.classList.remove('tree-cursor');
      if (newEl) {
        newEl.classList.add('tree-cursor');
        newEl.scrollIntoView({ block: 'nearest' });
      }
    }

    function toggleTreeCollapse(): void {
      const item = treeVisibleItems[treeCursorIndex];
      if (!item || item.type !== "folder") return;
      if (treeCollapsed.has(item.id)) {
        treeCollapsed.delete(item.id);
      } else {
        treeCollapsed.add(item.id);
      }
      renderTreeView();
    }

    function renderTreeOpenConfirm(): void {
      if (!pendingTreeOpenEntry) return;
      detailHeader.textContent = "Open Bookmark";
      showDetailPlaceholder(false);
      const path = pendingTreeOpenEntry.folderPath || "";
      detailContent.innerHTML = `<div class="ht-bm-confirm">
        <div class="ht-bm-confirm-icon">\u{1F517}</div>
        <div class="ht-bm-confirm-msg">
          Open <span class="ht-bm-confirm-title">&ldquo;${escapeHtml(pendingTreeOpenEntry.title || "Untitled")}&rdquo;</span>?
          ${path ? `<div class="ht-bm-confirm-path">${escapeHtml(path)}</div>` : ""}
        </div>
        <div class="ht-bm-confirm-hint">y / Enter confirm &middot; n / Esc cancel</div>
      </div>`;
    }

    // --- Confirm delete view ---
    function renderDeleteConfirm(): void {
      if (!pendingDeleteEntry) return;
      detailHeader.textContent = "Confirm Delete";
      showDetailPlaceholder(false);

      const path = pendingDeleteEntry.folderPath || "";
      detailContent.innerHTML = `<div class="ht-bm-confirm">
        <div class="ht-bm-confirm-icon">\u{1F5D1}</div>
        <div class="ht-bm-confirm-msg">
          Delete this bookmark?<br>
          <span class="ht-bm-confirm-title">${escapeHtml(pendingDeleteEntry.title || "Untitled")}</span>
          ${path ? `<div class="ht-bm-confirm-path">${escapeHtml(path)}</div>` : ""}
        </div>
        <div class="ht-bm-confirm-hint">y / Enter confirm &middot; n / Esc cancel</div>
      </div>`;
    }

    // --- Confirm move view ---
    function renderMoveConfirm(): void {
      if (!pendingMoveEntry || !pendingMoveParentId) return;
      detailHeader.textContent = "Confirm Move";
      showDetailPlaceholder(false);

      const fromPath = pendingMoveEntry.folderPath || "Unknown";
      const dest = moveFolders[moveTargetIndex];
      const title = pendingMoveEntry.title || "Untitled";

      // Build full path for destination folder by walking ancestors in the flat list
      const destSegments: string[] = [];
      if (dest) {
        const targetDepth = dest.depth;
        destSegments.push(dest.title);
        for (let i = moveTargetIndex - 1; i >= 0; i--) {
          if (moveFolders[i].depth < targetDepth && moveFolders[i].depth >= 1) {
            destSegments.unshift(moveFolders[i].title);
            if (moveFolders[i].depth === 1) break;
          }
        }
      }
      const toPath = destSegments.length > 0 ? destSegments.join(" \u203A ") : "folder";

      detailContent.innerHTML = `<div class="ht-bm-confirm">
        <div class="ht-bm-confirm-icon">\u{1F4C2}</div>
        <div class="ht-bm-confirm-msg">
          Move this bookmark?<br>
          <span class="ht-bm-confirm-title">${escapeHtml(title)}</span>
        </div>
        <div class="ht-bm-confirm-arrow">
          <span class="ht-bm-confirm-from">${escapeHtml(fromPath)}</span>
          <span style="font-weight:700">\u2192</span>
          <span class="ht-bm-confirm-to">${escapeHtml(toPath)}</span>
        </div>
        <div class="ht-bm-confirm-hint">y / Enter confirm &middot; n / Esc cancel</div>
      </div>`;
    }

    // --- Dynamic footer ---
    function updateFooter(): void {
      // Show × button in detail header when in a sub-mode
      detailHeaderClose.style.display = detailMode === "detail" ? "none" : "block";

      if (detailMode === "confirmDelete" || detailMode === "confirmMove") {
        footerEl.innerHTML = `<div class="ht-footer-row">
          <span>y / ${acceptKey} confirm</span>
          <span>n / ${closeKey} cancel</span>
        </div>`;
      } else if (detailMode === "move") {
        footerEl.innerHTML = `<div class="ht-footer-row">
          <span>j/k (vim) ${upKey}/${downKey} nav</span>
          <span>${acceptKey} confirm</span>
          <span>${closeKey} / m back</span>
        </div>`;
      } else if (detailMode === "tree") {
        if (pendingTreeOpenEntry) {
          footerEl.innerHTML = `<div class="ht-footer-row">
            <span>y / ${acceptKey} confirm</span>
            <span>n / ${closeKey} cancel</span>
          </div>`;
        } else {
          footerEl.innerHTML = `<div class="ht-footer-row">
            <span>j/k (vim) ${upKey}/${downKey} nav</span>
            <span>${acceptKey} fold/open</span>
            <span>${closeKey} / t back</span>
          </div>`;
        }
      } else {
        footerEl.innerHTML = `<div class="ht-footer-row">
          <span>j/k (vim) ${upKey}/${downKey} nav</span>
          <span>${switchKey} list</span>
          <span>${acceptKey} open</span>
          <span>${closeKey} close</span>
        </div>
        <div class="ht-footer-row">
          <span>t tree (toggle)</span>
          <span>m move</span>
          <span>d remove</span>
        </div>`;
      }
    }

    // --- Keyboard handler ---
    function keyHandler(e: KeyboardEvent): void {
      if (!panelOpen) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      // Alt+V toggles vim mode while panel is open
      if (matchesAction(e, config, "global", "toggleVim")) {
        e.preventDefault();
        e.stopPropagation();
        config.navigationMode = config.navigationMode === "vim" ? "basic" : "vim";
        saveKeybindings(config);
        showFeedback(config.navigationMode === "vim" ? "Vim motions ON" : "Vim motions OFF");
        const badge = shadow.querySelector(".ht-vim-badge");
        if (badge) {
          badge.classList.toggle("on", config.navigationMode === "vim");
          badge.classList.toggle("off", config.navigationMode !== "vim");
        }
        return;
      }

      // --- Move mode: intercept all keys for folder picker ---
      if (detailMode === "move") {
        if (e.key === "Escape" || e.key.toLowerCase() === "m") {
          e.preventDefault();
          e.stopPropagation();
          detailMode = "detail";
          scheduleDetailUpdate();
          updateFooter();
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          const entry = filtered[activeIndex];
          if (!entry) return;
          pendingMoveEntry = entry;
          pendingMoveParentId = moveFolders[moveTargetIndex]?.id || null;
          detailMode = "confirmMove";
          renderMoveConfirm();
          updateFooter();
          return;
        }
        const vim = config.navigationMode === "vim";
        if (e.key === "ArrowDown" || (vim && e.key === "j")) {
          e.preventDefault();
          e.stopPropagation();
          moveTargetIndex = Math.min(moveTargetIndex + 1, moveFolders.length - 1);
          renderMoveView();
          return;
        }
        if (e.key === "ArrowUp" || (vim && e.key === "k")) {
          e.preventDefault();
          e.stopPropagation();
          moveTargetIndex = Math.max(moveTargetIndex - 1, 0);
          renderMoveView();
          return;
        }
        e.stopPropagation();
        return;
      }

      // --- Tree mode: intercept keys for tree view ---
      if (detailMode === "tree") {
        // Tree open confirmation sub-state
        if (pendingTreeOpenEntry) {
          if (e.key === "y" || e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            const entry = pendingTreeOpenEntry;
            pendingTreeOpenEntry = null;
            openBookmark(entry);
            return;
          }
          if (e.key === "n" || e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            pendingTreeOpenEntry = null;
            renderTreeView();
            updateFooter();
            return;
          }
          e.stopPropagation();
          return;
        }

        if (e.key === "Escape" || e.key.toLowerCase() === "t") {
          e.preventDefault();
          e.stopPropagation();
          detailMode = "detail";
          scheduleDetailUpdate();
          updateFooter();
          return;
        }
        // Enter: fold on folder, open on entry
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          const item = treeVisibleItems[treeCursorIndex];
          if (!item) return;
          if (item.type === "folder") {
            toggleTreeCollapse();
          } else {
            const entry = allEntries.find((bm) => bm.id === item.id);
            if (entry) {
              pendingTreeOpenEntry = entry;
              renderTreeOpenConfirm();
              updateFooter();
            }
          }
          return;
        }
        // j/k/arrows navigate the tree cursor
        const vim = config.navigationMode === "vim";
        if (e.key === "ArrowDown" || (vim && e.key === "j")) {
          e.preventDefault();
          e.stopPropagation();
          moveTreeCursor(1);
          return;
        }
        if (e.key === "ArrowUp" || (vim && e.key === "k")) {
          e.preventDefault();
          e.stopPropagation();
          moveTreeCursor(-1);
          return;
        }
        e.stopPropagation();
        return;
      }

      // --- Confirm delete mode: y/Enter to confirm, n/Esc to cancel ---
      if (detailMode === "confirmDelete") {
        if (e.key === "y" || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          pendingDeleteEntry = null;
          detailMode = "detail";
          removeSelectedBookmark();
          updateFooter();
          return;
        }
        if (e.key === "n" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          pendingDeleteEntry = null;
          detailMode = "detail";
          scheduleDetailUpdate();
          updateFooter();
          return;
        }
        e.stopPropagation();
        return;
      }

      // --- Confirm move mode: y/Enter to confirm, n/Esc to cancel ---
      if (detailMode === "confirmMove") {
        if (e.key === "y" || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          pendingMoveEntry = null;
          pendingMoveParentId = null;
          detailMode = "detail";
          confirmMove();
          updateFooter();
          return;
        }
        if (e.key === "n" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          pendingMoveEntry = null;
          pendingMoveParentId = null;
          detailMode = "detail";
          scheduleDetailUpdate();
          updateFooter();
          return;
        }
        e.stopPropagation();
        return;
      }

      // Escape: close overlay
      if (matchesAction(e, config, "search", "close")) {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }

      // Backspace on empty input removes the last active filter pill
      if (e.key === "Backspace" && focusedPane === "input"
          && input.value === "" && activeFilters.length > 0) {
        e.preventDefault();
        activeFilters.pop();
        // Rebuild input text from remaining filters
        input.value = activeFilters.map((f) => `/${f}`).join(" ") + (activeFilters.length ? " " : "");
        updateTitle();
        updateFilterPills();
        // Re-trigger filter with no query
        currentQuery = "";
        applyFilter();
        renderResults();
        return;
      }

      // --- Normal mode ---
      if (matchesAction(e, config, "search", "accept")) {
        e.preventDefault();
        e.stopPropagation();
        if (filtered[activeIndex]) openBookmark(filtered[activeIndex]);
        return;
      }

      // Tab cycles between input and results list
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (filtered.length === 0) return;
        if (focusedPane === "input") {
          if (activeItemEl) {
            activeItemEl.focus();
          } else {
            const first = resultsList.querySelector(".ht-bm-item") as HTMLElement;
            if (first) first.focus();
          }
          setFocusedPane("results");
        } else {
          input.focus();
          setFocusedPane("input");
        }
        return;
      }

      const inputFocused = focusedPane === "input";

      // Remove bookmark: d/D (case-insensitive, only when list is focused)
      if (e.key.toLowerCase() === "d" && !e.ctrlKey && !e.altKey && !e.metaKey && !inputFocused) {
        e.preventDefault();
        e.stopPropagation();
        const entry = filtered[activeIndex];
        if (!entry) return;
        pendingDeleteEntry = entry;
        detailMode = "confirmDelete";
        renderDeleteConfirm();
        updateFooter();
        return;
      }

      // Move bookmark: m/M (case-insensitive, only when list is focused)
      if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.altKey && !e.metaKey && !inputFocused) {
        e.preventDefault();
        e.stopPropagation();
        if (!filtered[activeIndex]) return;
        detailMode = "move";
        moveFolders = flatFolderList.filter((f) => f.depth > 0);
        moveTargetIndex = 0;
        renderMoveView();
        updateFooter();
        return;
      }

      // Toggle tree view: t/T (case-insensitive, only when list is focused)
      if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.altKey && !e.metaKey && !inputFocused) {
        e.preventDefault();
        e.stopPropagation();
        if (flatFolderList.length === 0) return;
        detailMode = "tree";
        treeCollapsed.clear();
        treeCursorIndex = 0;
        renderTreeView();
        // Set initial cursor to the active entry's position in the tree
        const entry = filtered[activeIndex];
        if (entry) {
          const matchIdx = treeVisibleItems.findIndex(
            (item) => item.type === "entry" && item.id === entry.id,
          );
          if (matchIdx >= 0) {
            treeCursorIndex = matchIdx;
            renderTreeView();
          }
        }
        updateFooter();
        return;
      }

      if (matchesAction(e, config, "search", "moveDown")) {
        const lk = e.key.toLowerCase();
        if ((lk === "j" || lk === "k") && inputFocused) return;
        e.preventDefault();
        e.stopPropagation();
        if (filtered.length > 0) {
          setActiveIndex(Math.min(activeIndex + 1, filtered.length - 1));
        }
        return;
      }

      if (matchesAction(e, config, "search", "moveUp")) {
        const lk = e.key.toLowerCase();
        if ((lk === "j" || lk === "k") && inputFocused) return;
        e.preventDefault();
        e.stopPropagation();
        if (filtered.length > 0) {
          setActiveIndex(Math.max(activeIndex - 1, 0));
        }
        return;
      }

      // Block all other keys from reaching the page
      e.stopPropagation();
    }

    // --- Event binding ---
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (e) => e.preventDefault());

    // Detail header × button — exits tree/move/confirm modes
    detailHeaderClose.addEventListener("click", () => {
      if (detailMode !== "detail") {
        detailMode = "detail";
        pendingDeleteEntry = null;
        pendingMoveEntry = null;
        pendingMoveParentId = null;
        pendingTreeOpenEntry = null;
        scheduleDetailUpdate();
        updateFooter();
      }
    });

    // Event delegation for results list
    resultsList.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest(".ht-bm-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      setActiveIndex(Number(item.dataset.index));
    });

    resultsList.addEventListener("dblclick", (e) => {
      const item = (e.target as HTMLElement).closest(".ht-bm-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      const idx = Number(item.dataset.index);
      activeIndex = idx;
      if (filtered[idx]) openBookmark(filtered[idx]);
    });

    // Sync focusedPane on mouse clicks
    input.addEventListener("focus", () => { setFocusedPane("input"); });
    resultsList.addEventListener("focus", () => { setFocusedPane("results"); }, true);

    // Mouse wheel on results pane
    resultsPane.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length === 0) return;
      if (e.deltaY > 0) {
        setActiveIndex(Math.min(activeIndex + 1, filtered.length - 1));
      } else {
        setActiveIndex(Math.max(activeIndex - 1, 0));
      }
    });

    // Tree click handler — clicking folder headers toggles collapse,
    // clicking any node moves cursor to it
    detailContent.addEventListener("click", (e) => {
      if (detailMode !== "tree") return;
      const target = (e.target as HTMLElement).closest("[data-tree-idx]") as HTMLElement | null;
      if (!target) return;
      const idx = Number(target.dataset.treeIdx);
      if (isNaN(idx) || idx < 0 || idx >= treeVisibleItems.length) return;

      // Move cursor to clicked node
      const oldIdx = treeCursorIndex;
      treeCursorIndex = idx;
      const item = treeVisibleItems[idx];
      if (item.type === "folder") {
        // Toggle collapse for folder nodes (full re-render)
        toggleTreeCollapse();
      } else {
        // Swap cursor CSS classes without re-render so dblclick can fire
        const tree = detailContent.querySelector('.ht-bm-tree') as HTMLElement;
        if (tree) {
          const oldEl = tree.querySelector(`[data-tree-idx="${oldIdx}"]`) as HTMLElement;
          const newEl = tree.querySelector(`[data-tree-idx="${idx}"]`) as HTMLElement;
          if (oldEl) oldEl.classList.remove('tree-cursor');
          if (newEl) {
            newEl.classList.add('tree-cursor');
            newEl.scrollIntoView({ block: 'nearest' });
          }
        }
      }
    });

    // Double-click on tree entry — open with confirmation
    detailContent.addEventListener("dblclick", (e) => {
      if (detailMode !== "tree") return;
      const target = (e.target as HTMLElement).closest("[data-tree-idx]") as HTMLElement | null;
      if (!target) return;
      const idx = Number(target.dataset.treeIdx);
      if (isNaN(idx) || idx < 0 || idx >= treeVisibleItems.length) return;

      const item = treeVisibleItems[idx];
      if (item.type !== "entry") return;
      treeCursorIndex = idx;
      const entry = allEntries.find((bm) => bm.id === item.id);
      if (entry) {
        pendingTreeOpenEntry = entry;
        renderTreeOpenConfirm();
        updateFooter();
      }
    });

    // Scroll wheel on detail pane in tree mode — moves cursor
    detailContent.addEventListener("wheel", (e) => {
      if (detailMode !== "tree") return;
      e.preventDefault();
      e.stopPropagation();
      moveTreeCursor(e.deltaY > 0 ? 1 : -1);
    });

    input.addEventListener("input", () => {
      const { filters, query } = parseInput(input.value);
      activeFilters = filters;
      currentQuery = query;
      updateTitle();
      updateFilterPills();
      applyFilter();
      renderResults();
    });

    // --- Initial load ---
    const [bookmarks, folders] = await Promise.all([
      browser.runtime.sendMessage({ type: "BOOKMARK_LIST" }) as Promise<BookmarkEntry[]>,
      browser.runtime.sendMessage({ type: "BOOKMARK_FOLDERS" }) as Promise<BookmarkFolder[]>,
    ]);
    allEntries = bookmarks;
    folderTree = folders;
    flatFolderList = flattenFolders(folders);
    filtered = [...allEntries];

    document.addEventListener("keydown", keyHandler, true);
    renderResults();
    input.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open bookmark overlay:", err);
  }
}

// ---------------------------------------------------------------------------
// Standalone "Add Bookmark" overlay — triggered by Alt+Shift+B or `a` inside
// the bookmark overlay. Three-step state machine:
//   1. chooseType  — pick File (bookmark) or Folder
//   2. chooseDest  — pick destination folder (or root)
//   3. nameInput   — (folder only) enter a name for the new folder
// ---------------------------------------------------------------------------

export async function openAddBookmarkOverlay(
  config: KeybindingsConfig,
): Promise<void> {
  try {
    const { host, shadow } = createPanelHost();

    const style = document.createElement("style");
    style.textContent =
      getBaseStyles() +
      `
      .ht-addbm-container {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 380px; max-width: 90vw; max-height: 460px; background: #1e1e1e;
        border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
      }
      .ht-addbm-list { flex: 1; overflow-y: auto; padding: 4px 0; max-height: 340px; }
      .ht-addbm-item {
        padding: 8px 14px; cursor: pointer; font-size: 12px;
        color: #e0e0e0; display: flex; align-items: center; gap: 8px;
        outline: none; user-select: none;
      }
      .ht-addbm-item:hover { background: rgba(255,255,255,0.06); }
      .ht-addbm-item.active {
        background: rgba(10,132,255,0.15);
        border-left: 2px solid #0a84ff;
      }
      .ht-addbm-icon { flex-shrink: 0; font-size: 14px; }
      .ht-addbm-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ht-addbm-desc { font-size: 10px; color: #808080; }
      .ht-addbm-none {
        padding: 8px 14px; cursor: pointer; font-size: 12px;
        color: #808080; display: flex; align-items: center; gap: 8px;
        outline: none; user-select: none; font-style: italic;
      }
      .ht-addbm-none:hover { background: rgba(255,255,255,0.06); }
      .ht-addbm-none.active {
        background: rgba(10,132,255,0.15);
        border-left: 2px solid #0a84ff;
      }
      .ht-addbm-input-wrap {
        display: flex; align-items: center; padding: 8px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06); background: #252525;
      }
      .ht-addbm-prompt {
        color: #0a84ff; margin-right: 8px; font-weight: 600; font-size: 13px;
      }
      .ht-addbm-input {
        flex: 1; background: transparent; border: none; outline: none;
        color: #e0e0e0; font-family: inherit; font-size: 13px; caret-color: #0a84ff;
      }
      .ht-addbm-input::placeholder { color: #666; }
      .ht-addbm-error {
        padding: 4px 14px; font-size: 10px; color: #ff5f57; display: none;
      }
    `;
    shadow.appendChild(style);

    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "ht-backdrop";
    shadow.appendChild(backdrop);

    // Container
    const panel = document.createElement("div");
    panel.className = "ht-addbm-container";
    shadow.appendChild(panel);

    // Title bar
    const titlebar = document.createElement("div");
    titlebar.className = "ht-titlebar";
    titlebar.innerHTML = `
      <div class="ht-traffic-lights">
        <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
      </div>
      <span class="ht-titlebar-text">Add Bookmark</span>
      ${vimBadgeHtml(config)}`;
    panel.appendChild(titlebar);

    // Body (swapped per step)
    const body = document.createElement("div");
    body.style.cssText = "display:flex;flex-direction:column;flex:1;overflow:hidden;";
    panel.appendChild(body);

    // Footer
    const footer = document.createElement("div");
    footer.className = "ht-footer";
    panel.appendChild(footer);

    const titleText = titlebar.querySelector(".ht-titlebar-text") as HTMLElement;

    // --- State ---
    type Step = "chooseType" | "chooseDest" | "nameInput";
    let step: Step = "chooseType";
    let chosenType: "file" | "folder" = "file";
    let activeIndex = 0;
    let flatFolders: { id: string; title: string; depth: number }[] = [];
    let nameInputEl: HTMLInputElement | null = null;
    let errorEl: HTMLElement | null = null;

    function close(): void {
      document.removeEventListener("keydown", keyHandler, true);
      removePanelHost();
    }

    // --- Step 1: Choose type (File or Folder) ---
    function renderChooseType(): void {
      titleText.textContent = "Add Bookmark";
      activeIndex = 0;

      body.innerHTML = `<div class="ht-addbm-list">
        <div class="ht-addbm-item active" data-idx="0">
          <span class="ht-addbm-icon">\u{1F4C4}</span>
          <div>
            <div class="ht-addbm-name">File</div>
            <div class="ht-addbm-desc">Save current page as a bookmark</div>
          </div>
        </div>
        <div class="ht-addbm-item" data-idx="1">
          <span class="ht-addbm-icon">\u{1F4C1}</span>
          <div>
            <div class="ht-addbm-name">Folder</div>
            <div class="ht-addbm-desc">Create a new bookmark folder</div>
          </div>
        </div>
      </div>`;

      footer.innerHTML = `<div class="ht-footer-row">
        <span>j/k (vim) \u2191/\u2193 nav</span>
         <span>Enter select</span>
         <span>Esc cancel</span>
      </div>`;

      // Click handler
      const list = body.querySelector(".ht-addbm-list") as HTMLElement;
      list.addEventListener("click", (e) => {
        const item = (e.target as HTMLElement).closest("[data-idx]") as HTMLElement;
        if (!item) return;
        const idx = parseInt(item.dataset.idx!);
        chosenType = idx === 0 ? "file" : "folder";
        transitionToChooseDest();
      });
    }

    // --- Step 2: Choose destination folder ---
    async function transitionToChooseDest(): Promise<void> {
      step = "chooseDest";
      activeIndex = 0;

      const label = chosenType === "file" ? "save bookmark" : "create folder";
      titleText.textContent = `Choose where to ${label}`;

      // Fetch folders
      const folders = (await browser.runtime.sendMessage({
        type: "BOOKMARK_FOLDERS",
      })) as BookmarkFolder[];
      flatFolders = flattenFolders(folders);

      renderChooseDest();
    }

    function renderChooseDest(): void {
      let html = `<div class="ht-addbm-list">
        <div class="ht-addbm-none${activeIndex === 0 ? " active" : ""}" data-idx="0">
          \u2014 Root (no folder)
        </div>`;

      for (let i = 0; i < flatFolders.length; i++) {
        const f = flatFolders[i];
        const indent = f.depth > 0 ? `padding-left:${14 + f.depth * 16}px;` : "";
        html += `<div class="ht-addbm-item${activeIndex === i + 1 ? " active" : ""}" data-idx="${i + 1}" style="${indent}">
          <span class="ht-addbm-icon">\u{1F4C1}</span>
          <span class="ht-addbm-name">${escapeHtml(f.title)}</span>
        </div>`;
      }

      html += `</div>`;
      body.innerHTML = html;

      footer.innerHTML = `<div class="ht-footer-row">
        <span>j/k (vim) \u2191/\u2193 nav</span>
         <span>Enter select</span>
         <span>Esc back</span>
      </div>`;

      // Click handler
      const list = body.querySelector(".ht-addbm-list") as HTMLElement;
      list.addEventListener("click", (e) => {
        const item = (e.target as HTMLElement).closest("[data-idx]") as HTMLElement;
        if (!item) return;
        const idx = parseInt(item.dataset.idx!);
        confirmDest(idx);
      });
    }

    function getParentId(idx: number): string | undefined {
      return idx === 0 ? undefined : flatFolders[idx - 1]?.id;
    }

    function getParentLabel(idx: number): string {
      return idx === 0 ? "" : ` in ${flatFolders[idx - 1]?.title || "folder"}`;
    }

    async function confirmDest(idx: number): Promise<void> {
      if (chosenType === "file") {
        // Save bookmark directly
        const parentId = getParentId(idx);
        const msg: Record<string, unknown> = { type: "BOOKMARK_ADD" };
        if (parentId) msg.parentId = parentId;

        const result = (await browser.runtime.sendMessage(msg)) as {
          ok: boolean;
          title?: string;
        };

        if (result.ok) {
          showFeedback(`Bookmarked: ${result.title || "current page"}${getParentLabel(idx)}`);
        } else {
          showFeedback("Failed to add bookmark");
        }
        close();
      } else {
        // Folder — transition to name input
        transitionToNameInput(idx);
      }
    }

    // --- Step 3: Folder name input ---
    function transitionToNameInput(destIdx: number): void {
      step = "nameInput";
      const destLabel = destIdx === 0 ? "root" : flatFolders[destIdx - 1]?.title || "folder";
      titleText.textContent = `New folder in ${destLabel}`;

      body.innerHTML = `
        <div class="ht-addbm-input-wrap">
          <span class="ht-addbm-prompt">Name:</span>
          <input type="text" class="ht-addbm-input"
                 placeholder="e.g. Work, Research, Recipes..." maxlength="60" />
        </div>
        <div class="ht-addbm-error"></div>`;

      footer.innerHTML = `<div class="ht-footer-row">
        <span>Enter create</span>
        <span>Esc back</span>
      </div>`;

      nameInputEl = body.querySelector(".ht-addbm-input") as HTMLInputElement;
      errorEl = body.querySelector(".ht-addbm-error") as HTMLElement;
      nameInputEl.focus();

      // Store destIdx for confirm
      nameInputEl.dataset.destIdx = String(destIdx);
    }

    function showError(msg: string): void {
      if (!errorEl) return;
      errorEl.textContent = msg;
      errorEl.style.display = "";
      if (nameInputEl) nameInputEl.style.borderBottom = "1px solid #ff5f57";
      setTimeout(() => {
        if (errorEl) errorEl.style.display = "none";
        if (nameInputEl) nameInputEl.style.borderBottom = "";
      }, 2000);
    }

    async function confirmFolderCreate(): Promise<void> {
      if (!nameInputEl) return;
      const name = nameInputEl.value.trim();
      if (!name) {
        showError("A folder name is required");
        return;
      }
      const destIdx = parseInt(nameInputEl.dataset.destIdx || "0");
      const parentId = getParentId(destIdx);

      const msg: Record<string, unknown> = {
        type: "BOOKMARK_CREATE_FOLDER",
        title: name,
      };
      if (parentId) msg.parentId = parentId;

      const result = (await browser.runtime.sendMessage(msg)) as {
        ok: boolean;
        title?: string;
        reason?: string;
      };

      if (result.ok) {
        showFeedback(`Created folder: ${name}${getParentLabel(destIdx)}`);
      } else {
        showFeedback(result.reason || "Failed to create folder");
      }
      close();
    }

    // --- Shared highlight update ---
    function updateHighlight(newIndex: number, totalItems: number): void {
      if (newIndex < 0 || newIndex >= totalItems) return;
      const items = body.querySelectorAll("[data-idx]");
      items.forEach((el) => el.classList.remove("active"));
      activeIndex = newIndex;
      const activeEl = items[newIndex] as HTMLElement;
      if (activeEl) {
        activeEl.classList.add("active");
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }

    // --- Keyboard handler (dispatches per step) ---
    function keyHandler(e: KeyboardEvent): void {
      if (!document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      // --- nameInput step ---
      if (step === "nameInput") {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          // Go back to chooseDest
          step = "chooseDest";
          nameInputEl = null;
          errorEl = null;
          renderChooseDest();
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          confirmFolderCreate();
          return;
        }
        // Let typing flow to the input
        e.stopPropagation();
        return;
      }

      // --- chooseType / chooseDest steps ---
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (step === "chooseDest") {
          // Go back to chooseType
          step = "chooseType";
          activeIndex = 0;
          renderChooseType();
        } else {
          close();
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (step === "chooseType") {
          chosenType = activeIndex === 0 ? "file" : "folder";
          transitionToChooseDest();
        } else if (step === "chooseDest") {
          confirmDest(activeIndex);
        }
        return;
      }

      const totalItems = step === "chooseType" ? 2 : flatFolders.length + 1;
      const vim = config.navigationMode === "vim";

      if (e.key === "ArrowDown" || (vim && e.key === "j")) {
        e.preventDefault();
        e.stopPropagation();
        updateHighlight(Math.min(activeIndex + 1, totalItems - 1), totalItems);
        return;
      }

      if (e.key === "ArrowUp" || (vim && e.key === "k")) {
        e.preventDefault();
        e.stopPropagation();
        updateHighlight(Math.max(activeIndex - 1, 0), totalItems);
        return;
      }

      e.stopPropagation();
    }

    // Event binding
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (e) => e.preventDefault());
    titlebar.querySelector(".ht-dot-close")!.addEventListener("click", close);

    document.addEventListener("keydown", keyHandler, true);

    // Start at step 1
    renderChooseType();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open add-bookmark overlay:", err);
  }
}
