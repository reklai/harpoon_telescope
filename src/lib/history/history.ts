// History overlay — browse and search browser history with fuzzy filter.
// Two-pane layout modeled on the bookmark overlay:
//   Left pane (40%): history results list with virtual scrolling
//   Right pane (60%): detail view for selected entry
//
// Alt+Y to open, type to filter, /today /week /month time filters,
// d to delete, Enter to open, Tab to switch panes.

import browser from "webextension-polyfill";
import { matchesAction, keyToDisplay } from "../shared/keybindings";
import { createPanelHost, removePanelHost, registerPanelCleanup, getBaseStyles, vimBadgeHtml } from "../shared/panelHost";
import { escapeHtml, escapeRegex, extractDomain, buildFuzzyPattern } from "../shared/helpers";
import { showFeedback } from "../shared/feedback";
import historyStyles from "./history.css";

// Virtual scrolling constants
const ITEM_HEIGHT = 52;    // px per history row (two lines: title + url)
const POOL_BUFFER = 5;     // extra items above/below viewport
const MAX_HISTORY = 200;   // max entries fetched from browser.history

// Valid slash-command filters for history
type HistoryFilter = "today" | "week" | "month";
const VALID_FILTERS: Record<string, HistoryFilter> = {
  "/today": "today",
  "/week": "week",
  "/month": "month",
};

// Time ranges for each filter (in ms)
const FILTER_RANGES: Record<HistoryFilter, number> = {
  today: 24 * 60 * 60 * 1000,            // 24 hours
  week: 7 * 24 * 60 * 60 * 1000,         // 7 days
  month: 30 * 24 * 60 * 60 * 1000,       // 30 days
};

/** Build a fuzzy regex from a query string (each char matches with gaps) */


/** Format a timestamp as a human-readable relative time string */
function relativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

export async function openHistoryOverlay(
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
    style.textContent = getBaseStyles() + historyStyles;
    shadow.appendChild(style);

    // --- Build static shell ---
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div class="ht-backdrop"></div>
      <div class="ht-history-container">
        <div class="ht-titlebar">
          <div class="ht-traffic-lights">
            <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
          </div>
          <span class="ht-titlebar-text">
            <span class="ht-hist-title-label">History</span>
            <span class="ht-hist-title-sep">|</span>
            <span class="ht-hist-title-filters">Filters:
              <span class="ht-hist-title-filter" data-filter="today">/today</span>
              <span class="ht-hist-title-filter" data-filter="week">/week</span>
              <span class="ht-hist-title-filter" data-filter="month">/month</span>
            </span>
            <span class="ht-hist-title-count"></span>
          </span>
          ${vimBadgeHtml(config)}
        </div>
        <div class="ht-history-body">
          <div class="ht-history-input-wrap">
            <span class="ht-history-prompt">&gt;</span>
            <input type="text" class="ht-history-input" placeholder="Filter history..." />
          </div>
          <div class="ht-hist-filter-pills"></div>
          <div class="ht-history-columns">
            <div class="ht-hist-results-pane">
              <div class="ht-hist-results-sentinel"></div>
              <div class="ht-hist-results-list"></div>
            </div>
            <div class="ht-hist-detail-pane">
              <div class="ht-hist-detail-header"><span class="ht-hist-detail-header-text">Details</span><button class="ht-hist-detail-header-close" title="Back">&times;</button></div>
              <div class="ht-hist-detail-placeholder">Select a history entry</div>
              <div class="ht-hist-detail-content" style="display:none;"></div>
            </div>
          </div>
          <div class="ht-footer">
             <div class="ht-footer-row">
              <span>j/k (vim) ${upKey}/${downKey} nav</span>
              <span>${switchKey} list</span>
              <span>T tree (toggle)</span>
              <span>D remove</span>
              <span>${acceptKey} open</span>
              <span>${closeKey} close</span>
            </div>
          </div>
        </div>
      </div>
    `;
    shadow.appendChild(wrapper);

    // --- DOM refs ---
    const input = shadow.querySelector(".ht-history-input") as HTMLInputElement;
    const resultsList = shadow.querySelector(".ht-hist-results-list") as HTMLElement;
    const resultsSentinel = shadow.querySelector(".ht-hist-results-sentinel") as HTMLElement;
    const resultsPane = shadow.querySelector(".ht-hist-results-pane") as HTMLElement;
    const detailHeader = shadow.querySelector(".ht-hist-detail-header-text") as HTMLElement;
    const detailHeaderClose = shadow.querySelector(".ht-hist-detail-header-close") as HTMLElement;
    const detailPlaceholder = shadow.querySelector(".ht-hist-detail-placeholder") as HTMLElement;
    const detailContent = shadow.querySelector(".ht-hist-detail-content") as HTMLElement;
    const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;
    const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
    const titleFilterSpans = shadow.querySelectorAll(".ht-hist-title-filter") as NodeListOf<HTMLElement>;
    const titleCount = shadow.querySelector(".ht-hist-title-count") as HTMLElement;
    const filterPills = shadow.querySelector(".ht-hist-filter-pills") as HTMLElement;
    const footerEl = shadow.querySelector(".ht-footer") as HTMLElement;

    // --- State ---
    let allEntries: HistoryEntry[] = [];
    let filtered: HistoryEntry[] = [];
    let activeIndex = 0;
    let activeItemEl: HTMLElement | null = null;
    let focusedPane: "input" | "results" = "input";

    function setFocusedPane(pane: "input" | "results"): void {
      focusedPane = pane;
      resultsPane.classList.toggle("focused", pane === "results");
    }
    let activeFilters: HistoryFilter[] = [];
    let currentQuery = "";

    // Virtual scrolling state
    let vsStart = 0;
    let vsEnd = 0;
    let itemPool: HTMLElement[] = [];

    // Highlight regex (rebuilt on query change)
    let highlightRegex: RegExp | null = null;

    // rAF throttle for detail updates
    let detailRafId: number | null = null;

    // Confirm delete state
    let detailMode: "detail" | "confirmDelete" | "tree" = "detail";
    let pendingDeleteEntry: HistoryEntry | null = null;

    // Tree navigation state
    let treeCursorIndex = 0;
    let treeCollapsed = new Set<string>(); // collapsed bucket labels
    let treeVisibleItems: { type: "bucket" | "entry"; id: string }[] = [];
    let pendingTreeOpenEntry: HistoryEntry | null = null;
    let pendingTreeDeleteEntry: HistoryEntry | null = null;

    function close(): void {
      panelOpen = false;
      document.removeEventListener("keydown", keyHandler, true);
      if (detailRafId !== null) cancelAnimationFrame(detailRafId);
      removePanelHost();
    }

    // --- Input parsing (mirrors bookmark overlay pattern) ---
    function parseInput(raw: string): { filters: HistoryFilter[]; query: string } {
      const tokens = raw.trimStart().split(/\s+/);
      const filters: HistoryFilter[] = [];
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
        const filter = span.dataset.filter as HistoryFilter;
        span.classList.toggle("active", activeFilters.includes(filter));
      });
      titleCount.textContent = filtered.length > 0
        ? `${filtered.length} entr${filtered.length !== 1 ? "ies" : "y"}`
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
        `<span class="ht-hist-filter-pill" data-filter="${f}">/${f}<span class="ht-hist-filter-pill-x">\u00d7</span></span>`
      ).join("");
      // Click x to remove a filter from the input
      filterPills.querySelectorAll(".ht-hist-filter-pill-x").forEach((x) => {
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          const pill = (x as HTMLElement).parentElement!;
          const filter = pill.dataset.filter!;
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
      item.className = "ht-hist-item";
      item.tabIndex = -1;

      const info = document.createElement("div");
      info.className = "ht-hist-info";
      const title = document.createElement("div");
      title.className = "ht-hist-title";
      const urlLine = document.createElement("div");
      urlLine.className = "ht-hist-url-line";
      info.appendChild(title);
      info.appendChild(urlLine);
      item.appendChild(info);

      itemPool.push(item);
      return item;
    }

    function bindPoolItem(item: HTMLElement, resultIdx: number): void {
      const entry = filtered[resultIdx];
      item.dataset.index = String(resultIdx);

      const info = item.firstElementChild as HTMLElement;
      const titleEl = info.firstElementChild as HTMLElement;
      titleEl.innerHTML = highlightMatch(entry.title || "Untitled");

      const urlEl = info.lastElementChild as HTMLElement;
      const timeStr = relativeTime(entry.lastVisitTime);
      urlEl.innerHTML = `<span class="ht-hist-time-tag">${escapeHtml(timeStr)}</span>${highlightMatch(extractDomain(entry.url))}`;

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
        resultsList.innerHTML = `<div class="ht-hist-no-results">${
          currentQuery || activeFilters.length > 0 ? "No matching history" : "No history entries"
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
      if (detailMode === "confirmDelete") return;
      if (detailMode === "tree") { renderTreeView(); return; }

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
      html += `<div class="ht-hist-detail-field">
        <div class="ht-hist-detail-label">Title</div>
        <div class="ht-hist-detail-value">${escapeHtml(entry.title || "Untitled")}</div>
      </div>`;

      // URL
      html += `<div class="ht-hist-detail-field">
        <div class="ht-hist-detail-label">URL</div>
        <div class="ht-hist-detail-value"><a href="${escapeHtml(entry.url)}" target="_blank">${escapeHtml(entry.url)}</a></div>
      </div>`;

      // Last visited
      if (entry.lastVisitTime) {
        const date = new Date(entry.lastVisitTime);
        const dateStr = date.toLocaleDateString(undefined, {
          year: "numeric", month: "short", day: "numeric",
        });
        const timeStr = date.toLocaleTimeString(undefined, {
          hour: "2-digit", minute: "2-digit",
        });
        html += `<div class="ht-hist-detail-field">
          <div class="ht-hist-detail-label">Last Visited</div>
          <div class="ht-hist-detail-value">${escapeHtml(dateStr)} at ${escapeHtml(timeStr)} (${escapeHtml(relativeTime(entry.lastVisitTime))})</div>
        </div>`;
      }

      // Stats
      html += `<div class="ht-hist-detail-stats">
        <div class="ht-hist-stat">
          <span class="ht-hist-stat-value">${entry.visitCount || 0}</span>
          <span class="ht-hist-stat-label">Visits</span>
        </div>
        <div class="ht-hist-stat">
          <span class="ht-hist-stat-value">${escapeHtml(extractDomain(entry.url))}</span>
          <span class="ht-hist-stat-label">Domain</span>
        </div>
      </div>`;

      detailContent.innerHTML = html;
    }

    // --- Filtering ---
    function applyFilter(): void {
      let results = [...allEntries];

      // Apply time-based filters first
      if (activeFilters.length > 0) {
        const now = Date.now();
        // Use the widest time range among active filters (most permissive)
        let maxRange = 0;
        for (const f of activeFilters) {
          maxRange = Math.max(maxRange, FILTER_RANGES[f]);
        }
        const cutoff = now - maxRange;
        results = results.filter((e) => e.lastVisitTime >= cutoff);
      }

      // Apply text query
      if (currentQuery.trim()) {
        const re = buildFuzzyPattern(currentQuery);
        if (re) {
          results = results.filter(
            (e) => re.test(e.title) || re.test(e.url),
          );
        }
      }

      filtered = results;
      activeIndex = Math.min(activeIndex, Math.max(filtered.length - 1, 0));
    }

    // --- Actions ---
    async function openHistoryEntry(entry: HistoryEntry): Promise<void> {
      if (!entry) return;
      close();
      // Check if URL is already open — switch to it
      try {
        const tabs = await browser.tabs.query({ currentWindow: true });
        const existing = tabs.find((t) => t.url === entry.url);
        if (existing && existing.id) {
          await browser.tabs.update(existing.id, { active: true });
        } else {
          await browser.tabs.create({ url: entry.url, active: true });
        }
      } catch (_) {
        await browser.tabs.create({ url: entry.url, active: true });
      }
    }

    async function removeSelectedHistory(): Promise<void> {
      const entry = filtered[activeIndex];
      if (!entry) return;
      try {
        await browser.history.deleteUrl({ url: entry.url });
        showFeedback(`Removed: ${entry.title || entry.url}`);
        allEntries = allEntries.filter((e) => e.url !== entry.url);
        applyFilter();
        renderResults();
      } catch (_) {
        showFeedback("Failed to remove history entry");
      }
    }

    // --- Confirm delete view ---
    function renderDeleteConfirm(): void {
      if (!pendingDeleteEntry) return;
      detailHeader.textContent = "Confirm Delete";
      showDetailPlaceholder(false);

      const domain = extractDomain(pendingDeleteEntry.url);
      detailContent.innerHTML = `<div class="ht-hist-confirm">
        <div class="ht-hist-confirm-icon">\u{1F5D1}</div>
        <div class="ht-hist-confirm-msg">
          Delete this history entry?<br>
          <span class="ht-hist-confirm-title">${escapeHtml(pendingDeleteEntry.title || "Untitled")}</span>
          <div class="ht-hist-confirm-path">${escapeHtml(domain)}</div>
        </div>
        <div class="ht-hist-confirm-hint">y / Enter confirm &middot; n / Esc cancel</div>
      </div>`;
    }

    // --- Time-based tree view (toggled by `t`) ---
    type TimeBucket = { label: string; icon: string; entries: HistoryEntry[] };

    function buildTimeBuckets(entries: HistoryEntry[]): TimeBucket[] {
      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const buckets: TimeBucket[] = [
        { label: "Today",     icon: "\u{1F4C5}", entries: [] },
        { label: "Yesterday", icon: "\u{1F4C5}", entries: [] },
        { label: "This Week", icon: "\u{1F4C6}", entries: [] },
        { label: "Last Week", icon: "\u{1F4C6}", entries: [] },
        { label: "This Month",icon: "\u{1F4C5}", entries: [] },
        { label: "Older",     icon: "\u{1F4C2}", entries: [] },
      ];

      for (const e of entries) {
        const age = now - e.lastVisitTime;
        if (age < DAY)          buckets[0].entries.push(e);
        else if (age < 2 * DAY) buckets[1].entries.push(e);
        else if (age < 7 * DAY) buckets[2].entries.push(e);
        else if (age < 14 * DAY) buckets[3].entries.push(e);
        else if (age < 30 * DAY) buckets[4].entries.push(e);
        else                    buckets[5].entries.push(e);
      }
      return buckets;
    }

    function renderTreeView(): void {
      const entry = filtered[activeIndex];
      detailHeader.textContent = "Time Tree";
      showDetailPlaceholder(false);

      const buckets = buildTimeBuckets(filtered);

      // Build visible items list and HTML
      treeVisibleItems = [];
      let idx = 0;
      let html = '<div class="ht-hist-tree" style="max-height:none; border:none; border-radius:0; margin:0; padding:8px 0;">';
      for (const b of buckets) {
        if (b.entries.length === 0) continue;

        // Bucket header — highlight if active entry is in this bucket
        const bucketHasActive = entry && b.entries.some((e) => e.url === entry.url && e.lastVisitTime === entry.lastVisitTime);
        const collapsed = treeCollapsed.has(b.label);
        const arrow = collapsed ? '\u25B6' : '\u25BC';
        const isCursor = idx === treeCursorIndex;

        treeVisibleItems.push({ type: "bucket", id: b.label });
        html += `<div class="ht-hist-tree-node${bucketHasActive ? ' active' : ''}${isCursor ? ' tree-cursor' : ''}" data-tree-idx="${idx}">`;
        html += `<span class="ht-hist-tree-collapse">${arrow}</span> ${b.icon} ${escapeHtml(b.label)} (${b.entries.length})`;
        html += '</div>';
        idx++;

        // Child entries under this bucket (hidden if collapsed)
        if (!collapsed) {
          for (const child of b.entries) {
            const isActive = entry && child.url === entry.url && child.lastVisitTime === entry.lastVisitTime;
            const domain = extractDomain(child.url);
            const title = child.title || "Untitled";
            const isCur = idx === treeCursorIndex;

            treeVisibleItems.push({ type: "entry", id: `${child.lastVisitTime}:${child.url}` });
            html += `<div class="ht-hist-tree-entry${isActive ? ' active' : ''}${isCur ? ' tree-cursor' : ''}" data-tree-idx="${idx}">`;
            html += `\u{1F4C4} ${escapeHtml(title)}<span class="ht-hist-tree-domain">\u00b7 ${escapeHtml(domain)}</span>`;
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

      const tree = detailContent.querySelector('.ht-hist-tree') as HTMLElement;
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
      if (!item || item.type !== "bucket") return;
      if (treeCollapsed.has(item.id)) {
        treeCollapsed.delete(item.id);
      } else {
        treeCollapsed.add(item.id);
      }
      renderTreeView();
    }

    function renderTreeOpenConfirm(): void {
      if (!pendingTreeOpenEntry) return;
      detailHeader.textContent = "Open Entry";
      showDetailPlaceholder(false);
      const domain = extractDomain(pendingTreeOpenEntry.url);
      detailContent.innerHTML = `<div class="ht-hist-confirm">
        <div class="ht-hist-confirm-icon">\u{1F517}</div>
        <div class="ht-hist-confirm-msg">
          Open <span class="ht-hist-confirm-title">&ldquo;${escapeHtml(pendingTreeOpenEntry.title || "Untitled")}&rdquo;</span>?
          ${domain ? `<div class="ht-hist-confirm-path">${escapeHtml(domain)}</div>` : ""}
        </div>
        <div class="ht-hist-confirm-hint">y / Enter confirm &middot; n / Esc cancel</div>
      </div>`;
    }

    function renderTreeDeleteConfirm(): void {
      if (!pendingTreeDeleteEntry) return;
      detailHeader.textContent = "Confirm Delete";
      showDetailPlaceholder(false);
      const domain = extractDomain(pendingTreeDeleteEntry.url);
      detailContent.innerHTML = `<div class="ht-hist-confirm">
        <div class="ht-hist-confirm-icon">\u{1F5D1}</div>
        <div class="ht-hist-confirm-msg">
          Delete this history entry?<br>
          <span class="ht-hist-confirm-title">${escapeHtml(pendingTreeDeleteEntry.title || "Untitled")}</span>
          <div class="ht-hist-confirm-path">${escapeHtml(domain)}</div>
        </div>
        <div class="ht-hist-confirm-hint">y / Enter confirm &middot; n / Esc cancel</div>
      </div>`;
    }

    async function removeTreeHistoryEntry(): Promise<void> {
      if (!pendingTreeDeleteEntry) return;
      const entry = pendingTreeDeleteEntry;
      pendingTreeDeleteEntry = null;
      try {
        await browser.history.deleteUrl({ url: entry.url });
        showFeedback(`Removed: ${entry.title || entry.url}`);
        allEntries = allEntries.filter((e) => e.url !== entry.url);
        applyFilter();
        renderTreeView();
      } catch (_) {
        showFeedback("Failed to remove history entry");
        renderTreeView();
      }
    }

    // --- Dynamic footer ---
    function updateFooter(): void {
      detailHeaderClose.style.display = detailMode === "detail" ? "none" : "block";

      if (detailMode === "confirmDelete") {
        footerEl.innerHTML = `<div class="ht-footer-row">
          <span>Y / ${acceptKey} confirm</span>
          <span>N / ${closeKey} cancel</span>
        </div>`;
      } else if (detailMode === "tree") {
        if (pendingTreeOpenEntry || pendingTreeDeleteEntry) {
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
          <span>T tree (toggle)</span>
          <span>D remove</span>
          <span>${acceptKey} open</span>
          <span>${closeKey} close</span>
        </div>`;
      }
    }

    // --- Keyboard handler ---
    function keyHandler(e: KeyboardEvent): void {
      if (!panelOpen) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      // --- Confirm delete mode: y/Enter to confirm, n/Esc to cancel ---
      if (detailMode === "confirmDelete") {
        if (e.key === "y" || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          pendingDeleteEntry = null;
          detailMode = "detail";
          removeSelectedHistory();
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

      // --- Tree mode: intercept keys for tree view ---
      if (detailMode === "tree") {
        // Tree open confirmation sub-state
        if (pendingTreeOpenEntry) {
          if (e.key === "y" || e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            const entry = pendingTreeOpenEntry;
            pendingTreeOpenEntry = null;
            openHistoryEntry(entry);
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

        // Tree delete confirmation sub-state
        if (pendingTreeDeleteEntry) {
          if (e.key === "y" || e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            removeTreeHistoryEntry();
            updateFooter();
            return;
          }
          if (e.key === "n" || e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            pendingTreeDeleteEntry = null;
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
        // Delete entry in tree: d (only works on entry nodes)
        if (e.key.toLowerCase() === "d" && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          const item = treeVisibleItems[treeCursorIndex];
          if (!item || item.type !== "entry") return;
          // Parse id back to find the entry: id is "lastVisitTime:url"
          const sepIdx = item.id.indexOf(":");
          const ts = Number(item.id.substring(0, sepIdx));
          const url = item.id.substring(sepIdx + 1);
          const entry = filtered.find((h) => h.lastVisitTime === ts && h.url === url);
          if (!entry) return;
          pendingTreeDeleteEntry = entry;
          renderTreeDeleteConfirm();
          updateFooter();
          return;
        }
        // Enter: fold on bucket, open on entry
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          const item = treeVisibleItems[treeCursorIndex];
          if (!item) return;
          if (item.type === "bucket") {
            toggleTreeCollapse();
          } else {
            // Parse id back to find the entry: id is "lastVisitTime:url"
            const sepIdx = item.id.indexOf(":");
            const ts = Number(item.id.substring(0, sepIdx));
            const url = item.id.substring(sepIdx + 1);
            const entry = filtered.find((h) => h.lastVisitTime === ts && h.url === url);
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
        if (e.key === "ArrowDown" || (vim && e.key.toLowerCase() === "j")) {
          e.preventDefault();
          e.stopPropagation();
          moveTreeCursor(1);
          return;
        }
        if (e.key === "ArrowUp" || (vim && e.key.toLowerCase() === "k")) {
          e.preventDefault();
          e.stopPropagation();
          moveTreeCursor(-1);
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
        input.value = activeFilters.map((f) => `/${f}`).join(" ") + (activeFilters.length ? " " : "");
        updateTitle();
        updateFilterPills();
        currentQuery = "";
        applyFilter();
        renderResults();
        return;
      }

      // --- Normal mode ---
      if (matchesAction(e, config, "search", "accept")) {
        e.preventDefault();
        e.stopPropagation();
        if (filtered[activeIndex]) openHistoryEntry(filtered[activeIndex]);
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
            const first = resultsList.querySelector(".ht-hist-item") as HTMLElement;
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

      // Remove history entry: d/D (case-insensitive, only when list is focused)
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

      // Toggle tree view: t/T (case-insensitive, only when list is focused)
      if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.altKey && !e.metaKey && !inputFocused) {
        e.preventDefault();
        e.stopPropagation();
        if (filtered.length === 0) return;
        detailMode = "tree";
        treeCollapsed.clear();
        treeCursorIndex = 0;
        renderTreeView();
        // Set initial cursor to the active entry's position in the tree
        const entry = filtered[activeIndex];
        if (entry) {
          const matchIdx = treeVisibleItems.findIndex(
            (item) => item.type === "entry" && item.id === `${entry.lastVisitTime}:${entry.url}`,
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

    // Detail header x button — exits confirm mode
    detailHeaderClose.addEventListener("click", () => {
      if (detailMode !== "detail") {
        detailMode = "detail";
        pendingDeleteEntry = null;
        pendingTreeOpenEntry = null;
        pendingTreeDeleteEntry = null;
        scheduleDetailUpdate();
        updateFooter();
      }
    });

    // Event delegation for results list
    resultsList.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest(".ht-hist-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      setActiveIndex(Number(item.dataset.index));
    });

    resultsList.addEventListener("dblclick", (e) => {
      const item = (e.target as HTMLElement).closest(".ht-hist-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      const idx = Number(item.dataset.index);
      activeIndex = idx;
      if (filtered[idx]) openHistoryEntry(filtered[idx]);
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

    // Tree click handler — clicking bucket headers toggles collapse,
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
      if (item.type === "bucket") {
        // Toggle collapse for bucket nodes (full re-render)
        toggleTreeCollapse();
      } else {
        // Swap cursor CSS classes without re-render so dblclick can fire
        const tree = detailContent.querySelector('.ht-hist-tree') as HTMLElement;
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
      // Parse id back to find the entry: id is "lastVisitTime:url"
      const sepIdx = item.id.indexOf(":");
      const ts = Number(item.id.substring(0, sepIdx));
      const url = item.id.substring(sepIdx + 1);
      const entry = filtered.find((h) => h.lastVisitTime === ts && h.url === url);
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
    allEntries = (await browser.runtime.sendMessage({
      type: "HISTORY_LIST",
      maxResults: MAX_HISTORY,
    })) as HistoryEntry[];
    filtered = [...allEntries];

    document.addEventListener("keydown", keyHandler, true);
    registerPanelCleanup(close);
    renderResults();
    input.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open history overlay:", err);
  }
}
