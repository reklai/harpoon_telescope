// Bookmarks overlay — browse, fuzzy-filter, add/remove browser bookmarks.
// Two-pane layout inspired by the Search Current Page overlay:
//   Left pane (40%): bookmark results list with virtual scrolling
//   Right pane (60%): detail view or folder picker when adding
//
// Alt+B to open, type to filter, /folder toggle filter,
// a to add (with folder picker), d to remove, Enter to open, Tab to
// switch panes.

import browser from "webextension-polyfill";
import { matchesAction, keyToDisplay } from "../shared/keybindings";
import { createPanelHost, removePanelHost, registerPanelCleanup, getBaseStyles, vimBadgeHtml } from "../shared/panelHost";
import { escapeHtml, escapeRegex, extractDomain, buildFuzzyPattern } from "../shared/helpers";
import { parseSlashFilterQuery } from "../shared/filterInput";
import { showFeedback } from "../shared/feedback";
import { withPerfTrace } from "../shared/perf";
import bookmarksStyles from "./bookmarks.css";

// Virtual scrolling constants
const ITEM_HEIGHT = 44;    // px per bookmark row (two lines: title + url)
const POOL_BUFFER = 5;     // extra items above/below viewport

// Valid slash-command filters for bookmarks
type BookmarkFilter = "folder";
const VALID_FILTERS: Record<string, BookmarkFilter> = {
  "/folder": "folder",
};

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
    for (const folder of nodes) {
      flat.push({ id: folder.id, title: folder.title, depth: folder.depth });
      if (folder.children.length > 0) walk(folder.children);
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
    style.textContent = getBaseStyles() + bookmarksStyles;
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
              <div class="ht-bm-detail-header"><span class="ht-bm-detail-header-text">Bookmark Tree</span><button class="ht-bm-detail-header-close" title="Back">&times;</button></div>
              <div class="ht-bm-detail-placeholder">No bookmarks</div>
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
              <span>T focus tree</span>
              <span>C clear</span>
              <span>D del</span>
              <span>M move</span>
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
    const detailPane = shadow.querySelector(".ht-bm-detail-pane") as HTMLElement;
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
    let scrollRafId: number | null = null;

    // Folder tree for tree visualization and move feature
    let folderTree: BookmarkFolder[] = [];
    let flatFolderList: { id: string; title: string; depth: number }[] = [];
    let detailMode: "tree" | "treeNav" | "move" | "confirmDelete" | "confirmMove" = "tree";
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
    let pendingTreeDeleteEntry: BookmarkEntry | null = null;
    let pendingTreeDeleteFolder: { id: string; title: string } | null = null;

    function close(): void {
      panelOpen = false;
      document.removeEventListener("keydown", keyHandler, true);
      if (detailRafId !== null) cancelAnimationFrame(detailRafId);
      if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
      removePanelHost();
    }

    // --- Input parsing (mirrors search overlay pattern) ---
    function parseInput(raw: string): { filters: BookmarkFilter[]; query: string } {
      return parseSlashFilterQuery(raw, VALID_FILTERS);
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
      filterPills.innerHTML = activeFilters.map((filter) =>
        `<span class="ht-bm-filter-pill" data-filter="${filter}">/${filter}<span class="ht-bm-filter-pill-x">\u00d7</span></span>`
      ).join("");
      // Click x to remove a filter from the input
      filterPills.querySelectorAll(".ht-bm-filter-pill-x").forEach((removeButton) => {
        removeButton.addEventListener("click", (event) => {
          event.stopPropagation();
          const pill = (removeButton as HTMLElement).parentElement!;
          const filter = pill.dataset.filter!;
          // Remove this filter's slash command from the input
          const tokens = input.value.trimStart().split(/\s+/);
          const remaining = tokens.filter((token) => token !== `/${filter}`);
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
        const pattern = terms.map((term) => `(${escapeRegex(escapeHtml(term))})`).join("|");
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
      withPerfTrace("bookmarks.renderVisibleItems", () => {
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
      });
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

    function scheduleVisibleRender(): void {
      if (scrollRafId !== null) return;
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        if (filtered.length > 0) renderVisibleItems();
      });
    }

    // Scroll listener for virtual scrolling
    resultsPane.addEventListener("scroll", scheduleVisibleRender, { passive: true });

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
      if (detailMode === "move") return;
      if (detailMode === "confirmDelete") return;
      if (detailMode === "confirmMove") return;
      // Tree is always the right pane
      renderTreeView();
    }

    // --- Filtering ---
    // With no filters active: fuzzy-match query against title + url + parentTitle
    // With /folder active: fuzzy-match query against parentTitle only
    // Score a match: lower = better. Combines match type with tightness.
    // Returns -1 for no match.
    function scoreMatch(
      lowerText: string,
      rawText: string,
      lowerQuery: string,
      fuzzyRe: RegExp,
    ): number {
      if (lowerText === lowerQuery) return 0;             // exact match
      if (lowerText.startsWith(lowerQuery)) return 1;     // starts-with
      if (lowerText.includes(lowerQuery)) return 2;       // substring
      if (fuzzyRe.test(rawText)) return 3;                // fuzzy only
      return -1;                                          // no match
    }

    function applyFilter(): void {
      withPerfTrace("bookmarks.applyFilter", () => {
        let results = allEntries;
        const trimmedQuery = currentQuery.trim();

        if (trimmedQuery) {
          const re = buildFuzzyPattern(trimmedQuery);
          const substringRe = new RegExp(escapeRegex(trimmedQuery), "i");
          if (re) {
            if (activeFilters.length === 0) {
              const lowerQuery = trimmedQuery.toLowerCase();
              const ranked: Array<{
                entry: BookmarkEntry;
                titleScore: number;
                titleHit: boolean;
                titleLen: number;
                folderScore: number;
                folderHit: boolean;
              }> = [];

              // No filters — match against all fields using substring first, fuzzy as fallback
              for (const entry of results) {
                const title = entry.title || "";
                const url = entry.url || "";
                const folder = entry.folderPath || "";
                if (!(substringRe.test(title)
                  || substringRe.test(url)
                  || (folder !== "" && substringRe.test(folder))
                  || re.test(title)
                  || re.test(url)
                  || (folder !== "" && re.test(folder)))) {
                  continue;
                }

                const titleScore = scoreMatch(title.toLowerCase(), title, lowerQuery, re);
                const folderScore = folder !== ""
                  ? scoreMatch(folder.toLowerCase(), folder, lowerQuery, re)
                  : -1;
                ranked.push({
                  entry,
                  titleScore,
                  titleHit: titleScore >= 0,
                  titleLen: title.length,
                  folderScore,
                  folderHit: folderScore >= 0,
                });
              }

              // Rank by: title score → title length (shorter = tighter) → folder score → url score
              ranked.sort((a, b) => {
                // Title matches always beat non-title matches
                if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
                if (a.titleHit && b.titleHit) {
                  // Tighter title match wins
                  if (a.titleScore !== b.titleScore) return a.titleScore - b.titleScore;
                  // Same match type — shorter title = more relevant
                  return a.titleLen - b.titleLen;
                }
                // Neither hit title — compare folder
                if (a.folderHit !== b.folderHit) return a.folderHit ? -1 : 1;
                if (a.folderHit && b.folderHit) return a.folderScore - b.folderScore;
                return 0;
              });
              results = ranked.map((r) => r.entry);
            } else {
              // Filter-scoped matching: /folder — match against parentTitle only
              results = results.filter((entry) => (
                !!entry.folderPath && (substringRe.test(entry.folderPath) || re.test(entry.folderPath))
              ));
            }
          }
        } else if (activeFilters.length > 0) {
          // /folder active but no query — show all bookmarks that have a folder path
          results = results.filter((entry) => !!entry.folderPath);
        }

        filtered = results;
        activeIndex = 0;
      });
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
        const folder = moveFolders[i];
        const indent = (folder.depth - 1) * 16;
        const isActive = moveTargetIndex === i;
        html += `<div class="ht-bm-move-item${isActive ? ' active' : ''}" data-midx="${i}" style="padding-left:${14 + indent}px">`;
        html += `\u{1F4C1} ${escapeHtml(folder.title)}`;
        html += '</div>';
      }
      html += '</div>';
      detailContent.innerHTML = html;

      // Click handler (event delegation)
      const list = detailContent.querySelector(".ht-bm-move-list");
      if (list) {
        list.addEventListener("click", (event) => {
          const item = (event.target as HTMLElement).closest("[data-midx]") as HTMLElement;
          if (!item) return;
          moveTargetIndex = parseInt(item.dataset.midx!);
          const activeEntry = filtered[activeIndex];
          if (!activeEntry) return;
          pendingMoveEntry = activeEntry;
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
      detailMode = "tree";
      scheduleDetailUpdate();
      updateFooter();
    }

    // --- Tree view (always-visible right pane) ---
    function renderTreeView(): void {
      const entry = filtered[activeIndex];
      detailHeader.textContent = "Bookmark Tree";
      showDetailPlaceholder(false);

      const isFiltering = currentQuery.trim() !== "" || activeFilters.length > 0;

      // Group bookmarks by parentId — when filtering, only include matched entries
      const byParent = new Map<string, BookmarkEntry[]>();
      const sourceEntries = isFiltering ? filtered : allEntries;
      for (const bm of sourceEntries) {
        if (!bm.parentId) continue;
        let list = byParent.get(bm.parentId);
        if (!list) { list = []; byParent.set(bm.parentId, list); }
        list.push(bm);
      }

      // When filtering, compute which folder IDs to show (those with entries + ancestors)
      let visibleFolderIds: Set<string> | null = null;
      if (isFiltering) {
        visibleFolderIds = new Set<string>();
        // Add all folders that directly contain filtered entries
        for (const [folderId] of byParent) {
          visibleFolderIds.add(folderId);
        }
        // Walk up the tree: for each visible folder, mark all ancestors visible too
        // flatFolderList is pre-order, so walk backwards to find ancestors by depth
        const ancestorIds = new Set<string>();
        for (const folderId of visibleFolderIds) {
          // Find this folder's index in flatFolderList
          const folderIndex = flatFolderList.findIndex((folder) => folder.id === folderId);
          if (folderIndex < 0) continue;
          const folderDepth = flatFolderList[folderIndex].depth;
          // Walk backwards to find ancestors at each decreasing depth
          let targetDepth = folderDepth - 1;
          for (let i = folderIndex - 1; i >= 0 && targetDepth > 0; i--) {
            if (flatFolderList[i].depth === targetDepth) {
              ancestorIds.add(flatFolderList[i].id);
              targetDepth--;
            }
          }
        }
        for (const id of ancestorIds) visibleFolderIds.add(id);
      }

      // Build visible items list and HTML
      treeVisibleItems = [];
      let idx = 0;
      const showCursor = detailMode === "treeNav";
      let html = '<div class="ht-bm-tree" style="max-height:none; border:none; border-radius:0; margin:0; padding:8px 0;">';
      for (const folder of flatFolderList) {
        if (folder.depth === 0) continue; // skip invisible root

        // When filtering, skip folders that don't contain (or lead to) matches
        if (visibleFolderIds && !visibleFolderIds.has(folder.id)) continue;

        const folderIsActive = entry && folder.id === entry.parentId;
        const indent = (folder.depth - 1) * 14;
        // When filtering, auto-expand all folders; otherwise use user collapsed state
        const collapsed = isFiltering ? false : treeCollapsed.has(folder.id);
        const children = byParent.get(folder.id);
        const count = children ? children.length : 0;
        const hasChildren = count > 0;
        const arrow = hasChildren ? (collapsed ? '\u25B6' : '\u25BC') : '\u00A0\u00A0';
        const isCursor = showCursor && idx === treeCursorIndex;

        treeVisibleItems.push({ type: "folder", id: folder.id });
        html += `<div class="ht-bm-tree-node${folderIsActive ? ' active' : ''}${isCursor ? ' tree-cursor' : ''}" data-tree-idx="${idx}" style="padding-left:${10 + indent}px">`;
        html += `<span class="ht-bm-tree-collapse">${arrow}</span> \u{1F4C1} ${escapeHtml(folder.title)}${count > 0 ? ` (${count})` : ''}`;
        html += '</div>';
        idx++;

        // Bookmark entries under this folder (hidden if collapsed)
        if (children && !collapsed) {
          const entryIndent = indent + 14;
          for (const bm of children) {
            const isActive = entry && bm.id === entry.id;
            const domain = extractDomain(bm.url);
            const title = bm.title || "Untitled";
            const isCur = showCursor && idx === treeCursorIndex;

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

    function renderTreeDeleteConfirm(): void {
      if (!pendingTreeDeleteEntry) return;
      detailHeader.textContent = "Confirm Delete";
      showDetailPlaceholder(false);
      const path = pendingTreeDeleteEntry.folderPath || "";
      detailContent.innerHTML = `<div class="ht-bm-confirm">
        <div class="ht-bm-confirm-icon">\u{1F5D1}</div>
        <div class="ht-bm-confirm-msg">
          Delete this bookmark?<br>
          <span class="ht-bm-confirm-title">${escapeHtml(pendingTreeDeleteEntry.title || "Untitled")}</span>
          ${path ? `<div class="ht-bm-confirm-path">${escapeHtml(path)}</div>` : ""}
        </div>
        <div class="ht-bm-confirm-hint">y / Enter confirm &middot; n / Esc cancel</div>
      </div>`;
    }

    async function removeTreeBookmark(): Promise<void> {
      if (!pendingTreeDeleteEntry) return;
      const entry = pendingTreeDeleteEntry;
      pendingTreeDeleteEntry = null;
      const result = (await browser.runtime.sendMessage({
        type: "BOOKMARK_REMOVE",
        id: entry.id,
        url: entry.url,
      })) as { ok: boolean };
      if (result.ok) {
        showFeedback(`Removed: ${entry.title || entry.url}`);
        allEntries = allEntries.filter((e) => e.id !== entry.id);
        applyFilter();
        renderTreeView();
      } else {
        showFeedback("Failed to remove bookmark");
        renderTreeView();
      }
    }

    // Collect all descendant folder IDs (inclusive) for a given folder
    function getDescendantFolderIds(folderId: string): Set<string> {
      const ids = new Set<string>([folderId]);
      let found = false;
      let parentDepth = -1;
      for (const f of flatFolderList) {
        if (f.id === folderId) {
          found = true;
          parentDepth = f.depth;
          continue;
        }
        if (found) {
          if (f.depth > parentDepth) {
            ids.add(f.id);
          } else {
            break;
          }
        }
      }
      return ids;
    }

    function renderTreeDeleteFolderConfirm(): void {
      if (!pendingTreeDeleteFolder) return;
      detailHeader.textContent = "Confirm Delete";
      showDetailPlaceholder(false);
      const descendantIds = getDescendantFolderIds(pendingTreeDeleteFolder.id);
      const childCount = allEntries.filter((e) => e.parentId && descendantIds.has(e.parentId)).length;
      detailContent.innerHTML = `<div class="ht-bm-confirm">
        <div class="ht-bm-confirm-icon">\u{1F5D1}</div>
        <div class="ht-bm-confirm-msg">
          Delete this folder and all its contents?<br>
          <span class="ht-bm-confirm-title">${escapeHtml(pendingTreeDeleteFolder.title)}</span>
          <div class="ht-bm-confirm-path">${childCount} bookmark${childCount !== 1 ? "s" : ""} inside</div>
        </div>
        <div class="ht-bm-confirm-hint">y / Enter confirm &middot; n / Esc cancel</div>
      </div>`;
    }

    async function removeTreeFolder(): Promise<void> {
      if (!pendingTreeDeleteFolder) return;
      const folder = pendingTreeDeleteFolder;
      pendingTreeDeleteFolder = null;
      // Collect descendant folder IDs before removal
      const descendantIds = getDescendantFolderIds(folder.id);
      const result = (await browser.runtime.sendMessage({
        type: "BOOKMARK_REMOVE_TREE",
        id: folder.id,
      })) as { ok: boolean };
      if (result.ok) {
        showFeedback(`Removed folder: ${folder.title}`);
        allEntries = allEntries.filter((e) => !e.parentId || !descendantIds.has(e.parentId));
        // Re-fetch folder structure
        const folders = (await browser.runtime.sendMessage({ type: "BOOKMARK_FOLDERS" })) as BookmarkFolder[];
        folderTree = folders;
        flatFolderList = flattenFolders(folders);
        applyFilter();
        renderTreeView();
      } else {
        showFeedback("Failed to remove folder");
        renderTreeView();
      }
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
      // Show x button in detail header when in a sub-mode
      detailHeaderClose.style.display = detailMode === "tree" ? "none" : "block";
      // Highlight tree pane when focused, dim results pane (treeNav mode)
      detailPane.classList.toggle("focused", detailMode === "treeNav");
      resultsPane.classList.toggle("dimmed", detailMode === "treeNav");

      if (detailMode === "confirmDelete" || detailMode === "confirmMove") {
        footerEl.innerHTML = `<div class="ht-footer-row">
          <span>Y / ${acceptKey} confirm</span>
          <span>N / ${closeKey} cancel</span>
        </div>`;
      } else if (detailMode === "move") {
        footerEl.innerHTML = `<div class="ht-footer-row">
          <span>j/k (vim) ${upKey}/${downKey} nav</span>
          <span>${acceptKey} confirm</span>
          <span>${closeKey} / M back</span>
        </div>`;
      } else if (detailMode === "treeNav") {
        if (pendingTreeOpenEntry || pendingTreeDeleteEntry || pendingTreeDeleteFolder) {
          footerEl.innerHTML = `<div class="ht-footer-row">
            <span>Y / ${acceptKey} confirm</span>
            <span>N / ${closeKey} cancel</span>
          </div>`;
        } else {
          footerEl.innerHTML = `<div class="ht-footer-row">
            <span>j/k (vim) ${upKey}/${downKey} nav</span>
            <span>D del</span>
            <span>${acceptKey} fold/open</span>
            <span>${closeKey} / T back</span>
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
          <span>T focus tree</span>
          <span>C clear</span>
          <span>D del</span>
          <span>M move</span>
        </div>`;
      }
    }

    // --- Keyboard handler ---
    function keyHandler(event: KeyboardEvent): void {
      if (!panelOpen) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      // --- Move mode: intercept all keys for folder picker ---
      if (detailMode === "move") {
        if (event.key === "Escape" || event.key.toLowerCase() === "m") {
          event.preventDefault();
          event.stopPropagation();
          detailMode = "tree";
          scheduleDetailUpdate();
          updateFooter();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
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
        if (event.key === "ArrowDown" || (vim && event.key.toLowerCase() === "j")) {
          event.preventDefault();
          event.stopPropagation();
          moveTargetIndex = Math.min(moveTargetIndex + 1, moveFolders.length - 1);
          renderMoveView();
          return;
        }
        if (event.key === "ArrowUp" || (vim && event.key.toLowerCase() === "k")) {
          event.preventDefault();
          event.stopPropagation();
          moveTargetIndex = Math.max(moveTargetIndex - 1, 0);
          renderMoveView();
          return;
        }
        event.stopPropagation();
        return;
      }

      // --- Tree mode: intercept keys for tree view ---
      if (detailMode === "treeNav") {
        // Tree open confirmation sub-state
        if (pendingTreeOpenEntry) {
          if (event.key === "y" || event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            const entry = pendingTreeOpenEntry;
            pendingTreeOpenEntry = null;
            openBookmark(entry);
            return;
          }
          if (event.key === "n" || event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            pendingTreeOpenEntry = null;
            renderTreeView();
            updateFooter();
            return;
          }
          event.stopPropagation();
          return;
        }

        // Tree delete confirmation sub-state
        if (pendingTreeDeleteEntry) {
          if (event.key === "y" || event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            removeTreeBookmark();
            updateFooter();
            return;
          }
          if (event.key === "n" || event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            pendingTreeDeleteEntry = null;
            renderTreeView();
            updateFooter();
            return;
          }
          event.stopPropagation();
          return;
        }

        // Tree folder delete confirmation sub-state
        if (pendingTreeDeleteFolder) {
          if (event.key === "y" || event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            removeTreeFolder();
            updateFooter();
            return;
          }
          if (event.key === "n" || event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            pendingTreeDeleteFolder = null;
            renderTreeView();
            updateFooter();
            return;
          }
          event.stopPropagation();
          return;
        }

        if (event.key === "Escape" || event.key.toLowerCase() === "t") {
          event.preventDefault();
          event.stopPropagation();
          detailMode = "tree";
          scheduleDetailUpdate();
          updateFooter();
          return;
        }
        // Delete in tree: d (entries and folders)
        if (event.key.toLowerCase() === "d" && !event.ctrlKey && !event.altKey && !event.metaKey) {
          event.preventDefault();
          event.stopPropagation();
          const item = treeVisibleItems[treeCursorIndex];
          if (!item) return;
          if (item.type === "entry") {
            const entry = allEntries.find((bm) => bm.id === item.id);
            if (!entry) return;
            pendingTreeDeleteEntry = entry;
            renderTreeDeleteConfirm();
          } else {
            const folder = flatFolderList.find((f) => f.id === item.id);
            if (!folder) return;
            pendingTreeDeleteFolder = { id: folder.id, title: folder.title };
            renderTreeDeleteFolderConfirm();
          }
          updateFooter();
          return;
        }
        // Enter: fold on folder, open on entry
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
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
        if (event.key === "ArrowDown" || (vim && event.key.toLowerCase() === "j")) {
          event.preventDefault();
          event.stopPropagation();
          moveTreeCursor(1);
          return;
        }
        if (event.key === "ArrowUp" || (vim && event.key.toLowerCase() === "k")) {
          event.preventDefault();
          event.stopPropagation();
          moveTreeCursor(-1);
          return;
        }
        event.stopPropagation();
        return;
      }

      // --- Confirm delete mode: y/Enter to confirm, n/Esc to cancel ---
      if (detailMode === "confirmDelete") {
        if (event.key === "y" || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          pendingDeleteEntry = null;
          detailMode = "tree";
          removeSelectedBookmark();
          updateFooter();
          return;
        }
        if (event.key === "n" || event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          pendingDeleteEntry = null;
          detailMode = "tree";
          scheduleDetailUpdate();
          updateFooter();
          return;
        }
        event.stopPropagation();
        return;
      }

      // --- Confirm move mode: y/Enter to confirm, n/Esc to cancel ---
      if (detailMode === "confirmMove") {
        if (event.key === "y" || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          pendingMoveEntry = null;
          pendingMoveParentId = null;
          detailMode = "tree";
          confirmMove();
          updateFooter();
          return;
        }
        if (event.key === "n" || event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          pendingMoveEntry = null;
          pendingMoveParentId = null;
          detailMode = "tree";
          scheduleDetailUpdate();
          updateFooter();
          return;
        }
        event.stopPropagation();
        return;
      }

      // Escape: close overlay
      if (matchesAction(event, config, "search", "close")) {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }

      // Backspace on empty input removes the last active filter pill
      if (event.key === "Backspace" && focusedPane === "input"
          && input.value === "" && activeFilters.length > 0) {
        event.preventDefault();
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
      if (matchesAction(event, config, "search", "accept")) {
        event.preventDefault();
        event.stopPropagation();
        if (filtered[activeIndex]) openBookmark(filtered[activeIndex]);
        return;
      }

      // Tab cycles between input and results list
      if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
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
      if (event.key.toLowerCase() === "d" && !event.ctrlKey && !event.altKey && !event.metaKey && !inputFocused) {
        event.preventDefault();
        event.stopPropagation();
        const entry = filtered[activeIndex];
        if (!entry) return;
        pendingDeleteEntry = entry;
        detailMode = "confirmDelete";
        renderDeleteConfirm();
        updateFooter();
        return;
      }

      // Move bookmark: m/M (case-insensitive, only when list is focused)
      if (event.key.toLowerCase() === "m" && !event.ctrlKey && !event.altKey && !event.metaKey && !inputFocused) {
        event.preventDefault();
        event.stopPropagation();
        if (!filtered[activeIndex]) return;
        detailMode = "move";
        moveFolders = flatFolderList.filter((f) => f.depth > 0);
        moveTargetIndex = 0;
        renderMoveView();
        updateFooter();
        return;
      }

      // Toggle tree nav: t/T (case-insensitive, only when list is focused)
      if (event.key.toLowerCase() === "t" && !event.ctrlKey && !event.altKey && !event.metaKey && !inputFocused) {
        event.preventDefault();
        event.stopPropagation();
        if (flatFolderList.length === 0) return;
        detailMode = "treeNav";
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

      // Clear search: c/C (case-insensitive, only when list is focused)
      if (event.key.toLowerCase() === "c" && !event.ctrlKey && !event.altKey && !event.metaKey && !inputFocused) {
        event.preventDefault();
        event.stopPropagation();
        input.value = "";
        activeFilters = [];
        currentQuery = "";
        updateTitle();
        updateFilterPills();
        applyFilter();
        renderResults();
        scheduleDetailUpdate();
        return;
      }

      if (matchesAction(event, config, "search", "moveDown")) {
        const lk = event.key.toLowerCase();
        if ((lk === "j" || lk === "k") && inputFocused) return;
        event.preventDefault();
        event.stopPropagation();
        if (filtered.length > 0) {
          setActiveIndex(Math.min(activeIndex + 1, filtered.length - 1));
        }
        return;
      }

      if (matchesAction(event, config, "search", "moveUp")) {
        const lk = event.key.toLowerCase();
        if ((lk === "j" || lk === "k") && inputFocused) return;
        event.preventDefault();
        event.stopPropagation();
        if (filtered.length > 0) {
          setActiveIndex(Math.max(activeIndex - 1, 0));
        }
        return;
      }

      // Block all other keys from reaching the page
      event.stopPropagation();
    }

    // --- Event binding ---
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (event) => event.preventDefault());

    // Detail header x button — exits tree/move/confirm modes
    detailHeaderClose.addEventListener("click", () => {
      if (detailMode !== "tree") {
        detailMode = "tree";
        pendingDeleteEntry = null;
        pendingMoveEntry = null;
        pendingMoveParentId = null;
        pendingTreeOpenEntry = null;
        pendingTreeDeleteEntry = null;
        scheduleDetailUpdate();
        updateFooter();
      }
    });

    // Event delegation for results list
    resultsList.addEventListener("click", (event) => {
      const item = (event.target as HTMLElement).closest(".ht-bm-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      setActiveIndex(Number(item.dataset.index));
    });

    resultsList.addEventListener("dblclick", (event) => {
      const item = (event.target as HTMLElement).closest(".ht-bm-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      const idx = Number(item.dataset.index);
      activeIndex = idx;
      if (filtered[idx]) openBookmark(filtered[idx]);
    });

    // Sync focusedPane on mouse clicks
    input.addEventListener("focus", () => { setFocusedPane("input"); });
    resultsList.addEventListener("focus", () => { setFocusedPane("results"); }, true);

    // Mouse wheel on results pane
    resultsPane.addEventListener("wheel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (filtered.length === 0) return;
      if (event.deltaY > 0) {
        setActiveIndex(Math.min(activeIndex + 1, filtered.length - 1));
      } else {
        setActiveIndex(Math.max(activeIndex - 1, 0));
      }
    });

    // Tree click handler — clicking folder headers toggles collapse,
    // clicking any node moves cursor to it
    detailContent.addEventListener("click", (event) => {
      if (detailMode !== "tree" && detailMode !== "treeNav") return;
      const target = (event.target as HTMLElement).closest("[data-tree-idx]") as HTMLElement | null;
      if (!target) return;
      const idx = Number(target.dataset.treeIdx);
      if (isNaN(idx) || idx < 0 || idx >= treeVisibleItems.length) return;

      const item = treeVisibleItems[idx];
      if (item.type === "folder") {
        // Toggle collapse for folder nodes (works in both passive and treeNav)
        treeCursorIndex = idx;
        toggleTreeCollapse();
      } else if (detailMode === "treeNav") {
        // Move cursor to clicked entry (only in treeNav)
        const oldIdx = treeCursorIndex;
        treeCursorIndex = idx;
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
    detailContent.addEventListener("dblclick", (event) => {
      if (detailMode !== "treeNav") return;
      const target = (event.target as HTMLElement).closest("[data-tree-idx]") as HTMLElement | null;
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

    // Scroll wheel on detail pane in tree nav mode — moves cursor
    detailContent.addEventListener("wheel", (event) => {
      if (detailMode !== "treeNav") return;
      event.preventDefault();
      event.stopPropagation();
      moveTreeCursor(event.deltaY > 0 ? 1 : -1);
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
    registerPanelCleanup(close);
    renderResults();
    input.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open bookmark overlay:", err);
  }
}
