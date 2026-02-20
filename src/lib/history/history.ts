// History overlay — browse and search browser history with fuzzy filter.
// Two-pane layout modeled on the bookmark overlay:
//   Left pane (40%): history results list with virtual scrolling
//   Right pane (60%): detail view for selected entry
//
// Alt+Y to open, type to filter, /hour /today /week /month time filters,
// d to delete, Enter to open, Tab to switch panes.

import browser from "webextension-polyfill";
import { matchesAction, keyToDisplay } from "../shared/keybindings";
import { createPanelHost, removePanelHost, registerPanelCleanup, getBaseStyles, vimBadgeHtml } from "../shared/panelHost";
import { escapeHtml, escapeRegex, extractDomain, buildFuzzyPattern } from "../shared/helpers";
import { parseSlashFilterQuery } from "../shared/filterInput";
import { showFeedback } from "../shared/feedback";
import { withPerfTrace } from "../shared/perf";
import historyStyles from "./history.css";

// Virtual scrolling constants
const ITEM_HEIGHT = 44;    // px per history row (two lines: title + url)
const POOL_BUFFER = 5;     // extra items above/below viewport
const MAX_HISTORY = 200;   // max entries fetched from browser.history

// Valid slash-command filters for history
type HistoryFilter = "hour" | "today" | "week" | "month";
const VALID_FILTERS: Record<string, HistoryFilter> = {
  "/hour": "hour",
  "/today": "today",
  "/week": "week",
  "/month": "month",
};

// Time ranges for each filter (in ms)
const FILTER_RANGES: Record<HistoryFilter, number> = {
  hour: 60 * 60 * 1000,                  // 1 hour
  today: 24 * 60 * 60 * 1000,            // 24 hours
  week: 7 * 24 * 60 * 60 * 1000,         // 7 days
  month: 30 * 24 * 60 * 60 * 1000,       // 30 days
};

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
              <span class="ht-hist-title-filter" data-filter="hour">/hour</span>
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
              <span>${acceptKey} open</span>
              <span>${closeKey} close</span>
            </div>
            <div class="ht-footer-row">
              <span>T focus tree</span>
              <span>C clear</span>
              <span>D del</span>
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
    const detailPane = shadow.querySelector(".ht-hist-detail-pane") as HTMLElement;
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
    let initialLoadPending = true;

    // Virtual scrolling state
    let vsStart = 0;
    let vsEnd = 0;
    let itemPool: HTMLElement[] = [];

    // Highlight regex (rebuilt on query change)
    let highlightRegex: RegExp | null = null;

    // rAF throttle for detail updates
    let detailRafId: number | null = null;
    let scrollRafId: number | null = null;
    let inputRafId: number | null = null;
    let pendingInputValue = "";

    // Detail pane mode: tree (passive, always visible), treeNav (focused with cursor), confirmDelete
    let detailMode: "tree" | "treeNav" | "confirmDelete" = "tree";
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
      if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
      if (inputRafId !== null) cancelAnimationFrame(inputRafId);
      inputRafId = null;
      removePanelHost();
    }

    // --- Input parsing (mirrors bookmark overlay pattern) ---
    function parseInput(raw: string): { filters: HistoryFilter[]; query: string } {
      return parseSlashFilterQuery(raw, VALID_FILTERS);
    }

    function normalizeHistoryEntry(entry: unknown): HistoryEntry | null {
      if (!entry || typeof entry !== "object") return null;
      const candidate = entry as Partial<HistoryEntry>;
      const url = typeof candidate.url === "string" ? candidate.url.trim() : "";
      if (!url) return null;
      const title = typeof candidate.title === "string"
        ? candidate.title.trim().replace(/\s+/g, " ")
        : "";

      return {
        url,
        title,
        lastVisitTime:
          typeof candidate.lastVisitTime === "number" && Number.isFinite(candidate.lastVisitTime)
            ? candidate.lastVisitTime
            : 0,
        visitCount:
          typeof candidate.visitCount === "number" && Number.isFinite(candidate.visitCount)
            ? candidate.visitCount
            : 0,
      };
    }

    function normalizeHistoryList(rawEntries: unknown): HistoryEntry[] {
      const source = Array.isArray(rawEntries)
        ? rawEntries
        : (
            rawEntries
            && typeof rawEntries === "object"
            && Array.isArray((rawEntries as { entries?: unknown }).entries)
          )
          ? (rawEntries as { entries: unknown[] }).entries
          : [];
      return source
        .map((entry) => normalizeHistoryEntry(entry))
        .filter((entry): entry is HistoryEntry => entry !== null);
    }

    function canonicalHistoryUrl(rawUrl: string): string {
      const url = rawUrl.trim();
      if (!url) return "";
      try {
        const parsed = new URL(url);
        const protocol = parsed.protocol.toLowerCase();
        const host = parsed.hostname.toLowerCase();
        const port = parsed.port ? `:${parsed.port}` : "";
        let pathname = parsed.pathname || "/";
        if (pathname !== "/") {
          pathname = pathname.replace(/\/+$/, "");
          if (!pathname) pathname = "/";
        }

        const searchParams = new URLSearchParams(parsed.search);
        for (const key of Array.from(searchParams.keys())) {
          if (key.toLowerCase().startsWith("utm_")
            || key.toLowerCase() === "fbclid"
            || key.toLowerCase() === "gclid") {
            searchParams.delete(key);
          }
        }
        const query = searchParams.toString();

        return `${protocol}//${host}${port}${pathname}${query ? `?${query}` : ""}`;
      } catch {
        return url.toLowerCase().replace(/\/+$/, "");
      }
    }

    function historyEntryIdentity(entry: Pick<HistoryEntry, "url">): string {
      return canonicalHistoryUrl(entry.url);
    }

    function historyDisplayUrl(rawUrl: string): string {
      const canonical = canonicalHistoryUrl(rawUrl);
      if (!canonical) return rawUrl;
      try {
        const parsed = new URL(canonical);
        return `${parsed.hostname}${parsed.pathname}${parsed.search}`;
      } catch {
        return canonical;
      }
    }

    function dedupeHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
      const seen = new Set<string>();
      const unique: HistoryEntry[] = [];
      for (const entry of entries) {
        const key = historyEntryIdentity(entry);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unique.push(entry);
      }
      return unique;
    }

    async function fetchHistoryEntries(maxResults: number): Promise<HistoryEntry[]> {
      const rawEntries = await browser.runtime.sendMessage({
        type: "HISTORY_LIST",
        maxResults,
      });
      return dedupeHistoryEntries(normalizeHistoryList(rawEntries));
    }

    async function fetchHistoryEntriesWithRetry(): Promise<HistoryEntry[]> {
      const attemptSizes = [
        MAX_HISTORY,
        Math.max(500, MAX_HISTORY * 3),
        Math.max(1000, MAX_HISTORY * 5),
        Math.max(2000, MAX_HISTORY * 10),
      ];
      const retryDelaysMs = [100, 180, 320];

      for (let i = 0; i < attemptSizes.length; i++) {
        try {
          const entries = await fetchHistoryEntries(attemptSizes[i]);
          if (entries.length > 0 || i === attemptSizes.length - 1) return entries;
        } catch (error) {
          if (i === attemptSizes.length - 1) throw error;
        }

        if (i < retryDelaysMs.length) {
          // History API can occasionally return empty during startup churn.
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, retryDelaysMs[i]);
          });
        }
      }

      return [];
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
      filterPills.innerHTML = activeFilters.map((filter) =>
        `<span class="ht-hist-filter-pill" data-filter="${filter}">/${filter}<span class="ht-hist-filter-pill-x">\u00d7</span></span>`
      ).join("");
      // Click x to remove a filter from the input
      filterPills.querySelectorAll(".ht-hist-filter-pill-x").forEach((removeButton) => {
        removeButton.addEventListener("click", (event) => {
          event.stopPropagation();
          const pill = (removeButton as HTMLElement).parentElement!;
          const filter = pill.dataset.filter!;
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
      if (!entry) {
        item.classList.remove("active");
        return;
      }
      item.dataset.index = String(resultIdx);

      const info = item.firstElementChild as HTMLElement;
      const titleEl = info.firstElementChild as HTMLElement;
      titleEl.innerHTML = highlightMatch(entry.title || "Untitled");

      const urlEl = info.lastElementChild as HTMLElement;
      const timeStr = relativeTime(entry.lastVisitTime);
      const displayUrl = historyDisplayUrl(entry.url);
      urlEl.innerHTML = `<span class="ht-hist-time-tag">${escapeHtml(timeStr)}</span>${highlightMatch(displayUrl)}`;

      if (resultIdx === activeIndex) {
        item.classList.add("active");
        activeItemEl = item;
      } else {
        item.classList.remove("active");
      }
    }

    function renderVisibleItems(): void {
      withPerfTrace("history.renderVisibleItems", () => {
        const scrollTop = resultsPane.scrollTop;
        const viewHeight = resultsPane.clientHeight;

        const maxStart = Math.max(0, filtered.length - 1);
        const unclampedStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - POOL_BUFFER);
        const newStart = Math.min(unclampedStart, maxStart);
        const newEnd = Math.max(
          newStart,
          Math.min(filtered.length, Math.ceil((scrollTop + viewHeight) / ITEM_HEIGHT) + POOL_BUFFER),
        );

        if (newStart === vsStart && newEnd === vsEnd) return;
        vsStart = newStart;
        vsEnd = newEnd;

        resultsList.style.top = `${vsStart * ITEM_HEIGHT}px`;

        const count = Math.max(0, vsEnd - vsStart);
        while (resultsList.children.length > count) {
          const last = resultsList.lastChild;
          if (!last) break;
          resultsList.removeChild(last);
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
      try {
        buildHighlightRegex();
        updateTitle();

        if (initialLoadPending) {
          resultsSentinel.style.height = "0px";
          resultsList.style.top = "0px";
          resultsList.textContent = "";
          resultsList.innerHTML = `<div class="ht-hist-no-results">Loading history...</div>`;
          activeItemEl = null;
          vsStart = 0;
          vsEnd = 0;
          showDetailPlaceholder(true);
          return;
        }

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
      } catch (error) {
        console.error("[Harpoon Telescope] History render failed; dismissing panel.", error);
        close();
      }
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
      if (detailMode === "confirmDelete") return;
      // Guard treeNav sub-states (pending confirms)
      if (detailMode === "treeNav" && (pendingTreeOpenEntry || pendingTreeDeleteEntry)) return;
      renderTreeView();
    }

    function processInputValue(rawValue: string): void {
      const { filters, query } = parseInput(rawValue);
      activeFilters = filters;
      currentQuery = query;
      updateFilterPills();
      applyFilter();
      renderResults();
    }

    function scheduleInputProcessing(rawValue: string): void {
      pendingInputValue = rawValue;
      if (inputRafId !== null) return;
      inputRafId = requestAnimationFrame(() => {
        inputRafId = null;
        if (!panelOpen) return;
        try {
          processInputValue(pendingInputValue);
        } catch (error) {
          console.error("[Harpoon Telescope] History input processing failed; dismissing panel.", error);
          close();
        }
      });
    }

    // --- Filtering ---
    // 4-tier match scoring: exact (0) > starts-with (1) > substring (2) > fuzzy (3)
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
      try {
        withPerfTrace("history.applyFilter", () => {
          let results = allEntries;

          // Apply time-based filters first
          if (activeFilters.length > 0) {
            const now = Date.now();
            let maxRange = 0;
            for (const filter of activeFilters) {
              maxRange = Math.max(maxRange, FILTER_RANGES[filter]);
            }
            const cutoff = now - maxRange;
            results = results.filter((entry) => entry.lastVisitTime >= cutoff);
          }

          // Apply text query with ranked scoring
          const trimmedQuery = currentQuery.trim();
          if (trimmedQuery) {
            const re = buildFuzzyPattern(trimmedQuery);
            const substringRe = new RegExp(escapeRegex(trimmedQuery), "i");
            if (re) {
              const lowerQuery = trimmedQuery.toLowerCase();
              const ranked: Array<{
                entry: HistoryEntry;
                titleScore: number;
                titleHit: boolean;
                titleLen: number;
                urlScore: number;
                urlHit: boolean;
              }> = [];

              for (const entry of results) {
                const title = entry.title || "";
                const url = entry.url || "";
                if (!(substringRe.test(title) || substringRe.test(url) || re.test(title) || re.test(url))) {
                  continue;
                }

                const titleScore = scoreMatch(title.toLowerCase(), title, lowerQuery, re);
                const urlScore = scoreMatch(url.toLowerCase(), url, lowerQuery, re);
                ranked.push({
                  entry,
                  titleScore,
                  titleHit: titleScore >= 0,
                  titleLen: title.length,
                  urlScore,
                  urlHit: urlScore >= 0,
                });
              }

              // Rank by: title score > title length (shorter = tighter) > url score
              ranked.sort((a, b) => {
                // Title matches always beat non-title matches
                if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
                if (a.titleHit && b.titleHit) {
                  if (a.titleScore !== b.titleScore) return a.titleScore - b.titleScore;
                  return a.titleLen - b.titleLen;
                }
                // Neither hit title — compare url
                if (a.urlHit !== b.urlHit) return a.urlHit ? -1 : 1;
                if (a.urlHit && b.urlHit) return a.urlScore - b.urlScore;
                return 0;
              });
              results = ranked.map((r) => r.entry);
            }
          }

          filtered = dedupeHistoryEntries(results);
          activeIndex = 0;
        });
      } catch (error) {
        console.error("[Harpoon Telescope] History filtering failed; dismissing panel.", error);
        close();
      }
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
        try {
          await browser.tabs.create({ url: entry.url, active: true });
        } catch {
          showFeedback("Failed to open history entry");
        }
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

      for (const historyEntry of entries) {
        const age = now - historyEntry.lastVisitTime;
        if (age < DAY) buckets[0].entries.push(historyEntry);
        else if (age < 2 * DAY) buckets[1].entries.push(historyEntry);
        else if (age < 7 * DAY) buckets[2].entries.push(historyEntry);
        else if (age < 14 * DAY) buckets[3].entries.push(historyEntry);
        else if (age < 30 * DAY) buckets[4].entries.push(historyEntry);
        else buckets[5].entries.push(historyEntry);
      }
      return buckets;
    }

    function renderTreeView(): void {
      try {
        const entry = filtered[activeIndex];
        const activeIdentity = entry ? historyEntryIdentity(entry) : null;
        detailHeader.textContent = "Time Tree";
        showDetailPlaceholder(false);

        const isFiltering = currentQuery.trim() !== "" || activeFilters.length > 0;
        const buckets = buildTimeBuckets(filtered);
        const showCursor = detailMode === "treeNav";

        // Build visible items list and HTML
        treeVisibleItems = [];
        let idx = 0;
        let html = '<div class="ht-hist-tree" style="max-height:none; border:none; border-radius:0; margin:0; padding:8px 0;">';
        for (const bucket of buckets) {
          if (bucket.entries.length === 0) continue;

          // Bucket header — highlight if active entry is in this bucket
          const bucketHasActive = !!activeIdentity
            && bucket.entries.some(
              (historyEntry) => historyEntryIdentity(historyEntry) === activeIdentity,
            );
          // When filtering, auto-expand all buckets; otherwise use user collapsed state
          const collapsed = isFiltering ? false : treeCollapsed.has(bucket.label);
          const arrow = collapsed ? '\u25B6' : '\u25BC';
          const isCursor = showCursor && idx === treeCursorIndex;

          treeVisibleItems.push({ type: "bucket", id: bucket.label });
          html += `<div class="ht-hist-tree-node${bucketHasActive ? ' active' : ''}${isCursor ? ' tree-cursor' : ''}" data-tree-idx="${idx}">`;
          html += `<span class="ht-hist-tree-collapse">${arrow}</span> ${bucket.icon} ${escapeHtml(bucket.label)} (${bucket.entries.length})`;
          html += '</div>';
          idx++;

          // Child entries under this bucket (hidden if collapsed)
          if (!collapsed) {
            for (const child of bucket.entries) {
              const isActive = activeIdentity !== null && historyEntryIdentity(child) === activeIdentity;
              const domain = extractDomain(child.url);
              const title = child.title || "Untitled";
              const isCur = showCursor && idx === treeCursorIndex;

              treeVisibleItems.push({ type: "entry", id: historyEntryIdentity(child) });
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

        // Auto-scroll cursor into view (only in treeNav)
        if (showCursor) {
          const cursorEl = detailContent.querySelector('.tree-cursor') as HTMLElement;
          if (cursorEl) {
            cursorEl.scrollIntoView({ block: 'nearest' });
          }
        }
      } catch (error) {
        console.error("[Harpoon Telescope] History tree render failed; dismissing panel.", error);
        close();
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
      // Show x button in detail header when in a sub-mode
      detailHeaderClose.style.display = detailMode === "tree" ? "none" : "block";
      // Highlight tree pane when focused, dim results pane (treeNav mode)
      detailPane.classList.toggle("focused", detailMode === "treeNav");
      resultsPane.classList.toggle("dimmed", detailMode === "treeNav");

      if (detailMode === "confirmDelete") {
        footerEl.innerHTML = `<div class="ht-footer-row">
          <span>Y / ${acceptKey} confirm</span>
          <span>N / ${closeKey} cancel</span>
        </div>`;
      } else if (detailMode === "treeNav") {
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
          <span>${acceptKey} open</span>
          <span>${closeKey} close</span>
        </div>
        <div class="ht-footer-row">
          <span>T focus tree</span>
          <span>C clear</span>
          <span>D del</span>
        </div>`;
      }
    }

    // --- Keyboard handler ---
    function keyHandler(event: KeyboardEvent): void {
      if (!panelOpen) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      // --- Confirm delete mode: y/Enter to confirm, n/Esc to cancel ---
      if (detailMode === "confirmDelete") {
        if (event.key === "y" || event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          pendingDeleteEntry = null;
          detailMode = "tree";
          removeSelectedHistory();
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

      // --- TreeNav mode: intercept keys for tree navigation ---
      if (detailMode === "treeNav") {
        // Tree open confirmation sub-state
        if (pendingTreeOpenEntry) {
          if (event.key === "y" || event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            const entry = pendingTreeOpenEntry;
            pendingTreeOpenEntry = null;
            openHistoryEntry(entry);
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
            removeTreeHistoryEntry();
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

        if (event.key === "Escape" || event.key.toLowerCase() === "t") {
          event.preventDefault();
          event.stopPropagation();
          detailMode = "tree";
          scheduleDetailUpdate();
          updateFooter();
          return;
        }
        // Delete entry in tree: d (only works on entry nodes)
        if (event.key.toLowerCase() === "d" && !event.ctrlKey && !event.altKey && !event.metaKey) {
          event.preventDefault();
          event.stopPropagation();
          const item = treeVisibleItems[treeCursorIndex];
          if (!item || item.type !== "entry") return;
          const entry = filtered.find((h) => historyEntryIdentity(h) === item.id);
          if (!entry) return;
          pendingTreeDeleteEntry = entry;
          renderTreeDeleteConfirm();
          updateFooter();
          return;
        }
        // Enter: fold on bucket, open on entry
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          const item = treeVisibleItems[treeCursorIndex];
          if (!item) return;
          if (item.type === "bucket") {
            toggleTreeCollapse();
          } else {
            const entry = filtered.find((h) => historyEntryIdentity(h) === item.id);
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
        input.value = activeFilters.map((f) => `/${f}`).join(" ") + (activeFilters.length ? " " : "");
        updateTitle();
        updateFilterPills();
        currentQuery = "";
        applyFilter();
        renderResults();
        return;
      }

      // --- Normal mode ---
      if (matchesAction(event, config, "search", "accept")) {
        event.preventDefault();
        event.stopPropagation();
        if (filtered[activeIndex]) openHistoryEntry(filtered[activeIndex]);
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

      // Toggle tree nav: t/T (case-insensitive, only when list is focused)
      if (event.key.toLowerCase() === "t" && !event.ctrlKey && !event.altKey && !event.metaKey && !inputFocused) {
        event.preventDefault();
        event.stopPropagation();
        if (filtered.length === 0) return;
        detailMode = "treeNav";
        treeCursorIndex = 0;
        renderTreeView();
        // Set initial cursor to the active entry's position in the tree
        const entry = filtered[activeIndex];
        if (entry) {
          const matchIdx = treeVisibleItems.findIndex(
            (item) => item.type === "entry" && item.id === historyEntryIdentity(entry),
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

    // Detail header x button — exits sub-modes back to passive tree
    detailHeaderClose.addEventListener("click", () => {
      if (detailMode !== "tree") {
        detailMode = "tree";
        pendingDeleteEntry = null;
        pendingTreeOpenEntry = null;
        pendingTreeDeleteEntry = null;
        scheduleDetailUpdate();
        updateFooter();
      }
    });

    // Event delegation for results list
    resultsList.addEventListener("click", (event) => {
      const item = (event.target as HTMLElement).closest(".ht-hist-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      setActiveIndex(Number(item.dataset.index));
    });

    resultsList.addEventListener("dblclick", (event) => {
      const item = (event.target as HTMLElement).closest(".ht-hist-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      const idx = Number(item.dataset.index);
      activeIndex = idx;
      if (filtered[idx]) openHistoryEntry(filtered[idx]);
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

    // Tree click handler — bucket collapse in both modes, cursor only in treeNav
    detailContent.addEventListener("click", (event) => {
      if (detailMode !== "tree" && detailMode !== "treeNav") return;
      const target = (event.target as HTMLElement).closest("[data-tree-idx]") as HTMLElement | null;
      if (!target) return;
      const idx = Number(target.dataset.treeIdx);
      if (isNaN(idx) || idx < 0 || idx >= treeVisibleItems.length) return;

      const item = treeVisibleItems[idx];
      if (item.type === "bucket") {
        // Folder collapse works in both modes
        if (detailMode === "treeNav") treeCursorIndex = idx;
        toggleTreeCollapse();
      } else if (detailMode === "treeNav") {
        // Entry click only moves cursor in treeNav
        const oldIdx = treeCursorIndex;
        treeCursorIndex = idx;
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

    // Double-click on tree entry — open with confirmation (treeNav only)
    detailContent.addEventListener("dblclick", (event) => {
      if (detailMode !== "treeNav") return;
      const target = (event.target as HTMLElement).closest("[data-tree-idx]") as HTMLElement | null;
      if (!target) return;
      const idx = Number(target.dataset.treeIdx);
      if (isNaN(idx) || idx < 0 || idx >= treeVisibleItems.length) return;

      const item = treeVisibleItems[idx];
      if (item.type !== "entry") return;
      treeCursorIndex = idx;
      const entry = filtered.find((h) => historyEntryIdentity(h) === item.id);
      if (entry) {
        pendingTreeOpenEntry = entry;
        renderTreeOpenConfirm();
        updateFooter();
      }
    });

    // Scroll wheel on detail pane — moves cursor (treeNav only)
    detailContent.addEventListener("wheel", (event) => {
      if (detailMode !== "treeNav") return;
      event.preventDefault();
      event.stopPropagation();
      moveTreeCursor(event.deltaY > 0 ? 1 : -1);
    });

    input.addEventListener("input", () => {
      scheduleInputProcessing(input.value);
    });

    // --- Initial load ---
    document.addEventListener("keydown", keyHandler, true);
    registerPanelCleanup(close);
    renderResults();
    input.focus();
    // Let the shell/backdrop paint before we start async history fetch work.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!panelOpen) return;

    try {
      allEntries = await fetchHistoryEntriesWithRetry();
    } catch (error) {
      console.error("[Harpoon Telescope] History load failed after retries.", error);
      allEntries = [];
    }

    if (!panelOpen) return;
    initialLoadPending = false;
    applyFilter();
    renderResults();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open history overlay:", err);
  }
}
