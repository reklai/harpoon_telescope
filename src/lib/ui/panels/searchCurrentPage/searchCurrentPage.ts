// Search Current Page overlay — single-page fuzzy search with structural filters.
// Supports combinable slash-command filters: /code, /headings, /img, /links.
// Results include colored source-tag badges and a live preview pane.
//
// Performance:
//  - Virtual scrolling: only ~25 DOM items rendered, recycled on scroll
//  - Event delegation: single click/dblclick on results container
//  - rAF-throttled preview updates for smooth rapid navigation
//  - Line cache: DOM only walked once, re-filtered from cache on keystrokes
//  - Direct DOM refs: no querySelector for active item toggling

import { matchesAction, keyToDisplay } from "../../../common/contracts/keybindings";
import {
  createPanelHost,
  removePanelHost,
  registerPanelCleanup,
  getBaseStyles,
  dismissPanel,
} from "../../../common/utils/panelHost";
import { parseSlashFilterQuery } from "../../../common/utils/filterInput";
import { grepPage, enrichResult, initLineCache, destroyLineCache } from "./grep";
import { scrollToText } from "../../../common/utils/scroll";
import { showFeedback } from "../../../common/utils/feedback";
import { toastMessages } from "../../../common/utils/toastMessages";
import { withPerfTrace } from "../../../common/utils/perf";
import {
  movePanelListIndexByDirection,
  movePanelListIndexFromWheel,
  movePanelListIndexHalfPage,
} from "../../../core/panel/panelListController";
import {
  buildHighlightRegex,
  buildSearchCurrentPageHtml,
  buildSearchFooterHtml,
  getTagBadgeColors,
  highlightText,
  ITEM_HEIGHT,
  MAX_DOM_ELEMENTS,
  MAX_TEXT_BYTES,
  POOL_BUFFER,
  renderSearchPreview,
  VALID_FILTERS,
} from "./searchCurrentPageView";
import previewPaneStyles from "../../../common/utils/previewPane.css";
import searchCurrentPageStyles from "./searchCurrentPage.css";

// Preserves the previous query while the user stays on the page.
let lastSearchState: { query: string } | null = null;

export async function openSearchCurrentPage(
  config: KeybindingsConfig,
): Promise<void> {
  try {
    const closeKeyDisplay = keyToDisplay(config.bindings.search.close.key);

    // Start cache/observer before first query so repeated searches stay fast.
    initLineCache();

    // Hard guardrail: skip pages large enough to lock the tab on full text scan.
    const elementCount = document.body.querySelectorAll("*").length;
    const textLength = document.body.textContent?.length ?? 0;
    if (elementCount > MAX_DOM_ELEMENTS || textLength > MAX_TEXT_BYTES) {
      destroyLineCache();
      showFeedback(toastMessages.pageTooLargeToSearch);
      return;
    }

    const { host, shadow } = createPanelHost();
    let panelOpen = true;

    const style = document.createElement("style");
    style.textContent = getBaseStyles() + previewPaneStyles + searchCurrentPageStyles;
    shadow.appendChild(style);

    const wrapper = document.createElement("div");
    wrapper.innerHTML = buildSearchCurrentPageHtml(config, closeKeyDisplay);
    shadow.appendChild(wrapper);

    const footer = shadow.querySelector(".ht-footer") as HTMLElement;
    function renderFooter(): void {
      footer.innerHTML = buildSearchFooterHtml(config);
    }

    function onNavigationModeChanged(): void {
      renderFooter();
    }

    renderFooter();

    const input = shadow.querySelector(".ht-search-page-input") as HTMLInputElement;
    const resultsList = shadow.querySelector(".ht-results-list") as HTMLElement;
    const resultsSentinel = shadow.querySelector(".ht-results-sentinel") as HTMLElement;
    const previewHeader = shadow.querySelector(".ht-preview-header") as HTMLElement;
    const previewBreadcrumb = shadow.querySelector(".ht-preview-breadcrumb") as HTMLElement;
    const previewPlaceholder = shadow.querySelector(".ht-preview-placeholder") as HTMLElement;
    const previewContent = shadow.querySelector(".ht-preview-content") as HTMLElement;
    const filterPills = shadow.querySelector(".ht-filter-pills") as HTMLElement;
    const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;
    const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
    const resultsPane = shadow.querySelector(".ht-results-pane") as HTMLElement;
    const titleFilterSpans = shadow.querySelectorAll(".ht-title-filter") as NodeListOf<HTMLElement>;
    const titleCount = shadow.querySelector(".ht-title-count") as HTMLElement;

    let results: GrepResult[] = [];
    let activeIndex = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let currentQuery = "";
    let activeFilters: SearchFilter[] = [];
    // Keep direct refs so keyboard navigation avoids repeated DOM queries.
    let activeItemEl: HTMLElement | null = null;
    let focusedPane: "input" | "results" = "input";

    function setFocusedPane(pane: "input" | "results"): void {
      focusedPane = pane;
      resultsPane.classList.toggle("focused", pane === "results");
    }

    // Coalesce rapid input/scroll/navigation into one render per frame.
    let previewRafId: number | null = null;
    let scrollRafId: number | null = null;
    let inputRafId: number | null = null;
    let pendingInputValue = "";

    // Virtual-list window + reusable row pool to keep DOM churn bounded.
    let vsStart = 0;
    let vsEnd = 0;
    let itemPool: HTMLElement[] = [];

    function close(): void {
      panelOpen = false;
      lastSearchState = { query: input.value };
      document.removeEventListener("keydown", keyHandler, true);
      window.removeEventListener("ht-navigation-mode-changed", onNavigationModeChanged);
      if (previewRafId !== null) cancelAnimationFrame(previewRafId);
      if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
      if (inputRafId !== null) cancelAnimationFrame(inputRafId);
      if (debounceTimer) clearTimeout(debounceTimer);
      inputRafId = null;
      debounceTimer = null;
      destroyLineCache();
      removePanelHost();
    }

    function failClose(context: string, error: unknown): void {
      console.error(`[Harpoon Telescope] ${context}; dismissing panel.`, error);
      close();
    }

    function updateTitle(): void {
      titleFilterSpans.forEach((span) => {
        const filter = span.dataset.filter as SearchFilter;
        span.classList.toggle("active", activeFilters.includes(filter));
      });
      titleCount.textContent = results.length > 0
        ? `${results.length} match${results.length !== 1 ? "es" : ""}`
        : "";
    }

    function updateFilterPills(): void {
      if (activeFilters.length === 0) {
        filterPills.style.display = "none";
        return;
      }
      filterPills.style.display = "flex";
      filterPills.innerHTML = activeFilters.map((filter) =>
        `<span class="ht-filter-pill" data-filter="${filter}">/${filter}<span class="ht-filter-pill-x">\u00d7</span></span>`
      ).join("");
      filterPills.querySelectorAll(".ht-filter-pill-x").forEach((removeButton) => {
        removeButton.addEventListener("click", (event) => {
          event.stopPropagation();
          const pill = (removeButton as HTMLElement).parentElement!;
          const filter = pill.dataset.filter!;
          const tokens = input.value.trimStart().split(/\s+/);
          const remainingTokens = tokens.filter((token) => token !== `/${filter}`);
          input.value = remainingTokens.join(" ");
          input.dispatchEvent(new Event("input"));
          input.focus();
        });
      });
    }

    function parseInput(raw: string): { filters: SearchFilter[]; query: string } {
      return parseSlashFilterQuery(raw, VALID_FILTERS);
    }

    let highlightRegex: RegExp | null = null;

    /** Get or create a pooled result item element */
    function getPoolItem(poolIdx: number): HTMLElement {
      if (poolIdx < itemPool.length) return itemPool[poolIdx];
      const item = document.createElement("div");
      item.className = "ht-result-item";
      item.tabIndex = -1;
      const badge = document.createElement("span");
      badge.className = "ht-result-tag";
      item.appendChild(badge);
      const span = document.createElement("span");
      span.className = "ht-result-text";
      item.appendChild(span);
      itemPool.push(item);
      return item;
    }

    /** Populate a pool item with data for a specific result index */
    function bindPoolItem(item: HTMLElement, resultIdx: number): void {
      const result = results[resultIdx];
      if (!result) {
        item.classList.remove("active");
        return;
      }
      item.dataset.index = String(resultIdx);

      const badge = item.children[0] as HTMLElement;
      if (result.tag) {
        const colors = getTagBadgeColors(result.tag);
        badge.style.background = colors.bg;
        badge.style.color = colors.fg;
        badge.textContent = result.tag;
        badge.style.display = "";
      } else {
        badge.style.display = "none";
      }

      const span = item.children[1] as HTMLElement;
      span.innerHTML = highlightText(result.text, highlightRegex);

      if (resultIdx === activeIndex) {
        item.classList.add("active");
        activeItemEl = item;
      } else {
        item.classList.remove("active");
      }
    }

    /** Render only the visible window of results into the DOM */
    function renderVisibleItems(): void {
      try {
        withPerfTrace("searchCurrentPage.renderVisibleItems", () => {
          const scrollTop = resultsPane.scrollTop;
          const viewHeight = resultsPane.clientHeight;

          const maxStart = Math.max(0, results.length - 1);
          const unclampedStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - POOL_BUFFER);
          const newStart = Math.min(unclampedStart, maxStart);
          const newEnd = Math.max(
            newStart,
            Math.min(results.length, Math.ceil((scrollTop + viewHeight) / ITEM_HEIGHT) + POOL_BUFFER),
          );

          // No-op when the visible window is unchanged.
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

          // Reuse row elements and rebind data instead of rebuilding all rows.
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
      } catch (error) {
        failClose("Page-search virtual render failed", error);
      }
    }

    /** Full re-render after results change */
    function renderResults(): void {
      try {
        withPerfTrace("searchCurrentPage.renderResults", () => {
          highlightRegex = buildHighlightRegex(currentQuery);

          if (results.length === 0) {
            resultsSentinel.style.height = "0px";
            resultsList.style.top = "0px";
            resultsList.textContent = "";
            resultsList.innerHTML = input.value
              ? '<div class="ht-no-results">No matches found</div>'
              : '<div class="ht-no-results">Type to search...</div>';
            previewHeader.textContent = "Preview";
            showPreviewPlaceholder(true);
            activeItemEl = null;
            vsStart = 0;
            vsEnd = 0;
            return;
          }

          resultsSentinel.style.height = `${results.length * ITEM_HEIGHT}px`;
          resultsPane.scrollTop = 0;
          vsStart = 0;
          vsEnd = 0;
          resultsList.textContent = "";
          renderVisibleItems();
        });
      } catch (error) {
        failClose("Page-search render failed", error);
      }
    }

    function scheduleVisibleRender(): void {
      if (scrollRafId !== null) return;
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        if (results.length > 0) renderVisibleItems();
      });
    }

    // Passive scroll keeps the page thread responsive while browsing results.
    resultsPane.addEventListener("scroll", scheduleVisibleRender, { passive: true });

    function setActiveIndex(newIndex: number): void {
      if (newIndex < 0 || newIndex >= results.length) return;
      if (newIndex === activeIndex && activeItemEl) {
        schedulePreviewUpdate();
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
      schedulePreviewUpdate();
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

    function showPreviewPlaceholder(show: boolean): void {
      previewPlaceholder.style.display = show ? "flex" : "none";
      previewContent.style.display = show ? "none" : "block";
      previewBreadcrumb.style.display = show ? "none" : "";
    }

    function schedulePreviewUpdate(): void {
      if (previewRafId !== null) return;
      previewRafId = requestAnimationFrame(() => {
        previewRafId = null;
        updatePreview();
      });
    }

    function updatePreview(): void {
      try {
        renderSearchPreview({
          results,
          activeIndex,
          highlightRegex,
          previewHeader,
          previewBreadcrumb,
          previewPlaceholder,
          previewContent,
          enrichResult,
        });
      } catch (error) {
        failClose("Page-search preview render failed", error);
      }
    }

    resultsList.addEventListener("click", (event) => {
      const item = (event.target as HTMLElement).closest(".ht-result-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      setActiveIndex(Number(item.dataset.index));
    });

    resultsList.addEventListener("dblclick", (event) => {
      const item = (event.target as HTMLElement).closest(".ht-result-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      const selectedIndex = Number(item.dataset.index);
      activeIndex = selectedIndex;
      if (results[selectedIndex]) jumpToResult(results[selectedIndex]);
    });

    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (event) => event.preventDefault());

    input.addEventListener("focus", () => { setFocusedPane("input"); });
    resultsList.addEventListener("focus", () => { setFocusedPane("results"); }, true);

    function processInputValue(rawValue: string): void {
      if (debounceTimer) clearTimeout(debounceTimer);
      const { filters, query } = parseInput(rawValue);
      activeFilters = filters;
      updateTitle();
      updateFilterPills();

      if (query.length < 2) {
        results = [];
        currentQuery = "";
        renderResults();
        schedulePreviewUpdate();
        return;
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (!panelOpen) return;
        doGrep(query);
      }, 200);
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
          console.error("[Harpoon Telescope] Page-search input processing failed; dismissing panel.", error);
          close();
        }
      });
    }

    input.addEventListener("input", () => {
      scheduleInputProcessing(input.value);
    });

    function doGrep(query: string): void {
      if (!panelOpen) return;
      try {
        if (!query || query.trim().length === 0) {
          results = [];
          renderResults();
          return;
        }
        currentQuery = query.trim();
        results = grepPage(currentQuery, activeFilters);
        activeIndex = 0;
        updateTitle();
        renderResults();
        schedulePreviewUpdate();
      } catch (error) {
        failClose("Page-search grep failed", error);
      }
    }

    async function jumpToResult(result: GrepResult): Promise<void> {
      close();
      scrollToText(result.text, result.nodeRef);
    }

    function getHalfPageStep(): number {
      const rows = Math.max(1, Math.floor(resultsPane.clientHeight / ITEM_HEIGHT));
      return Math.max(1, Math.floor(rows / 2));
    }

    function keyHandler(event: KeyboardEvent): void {
      if (!panelOpen) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      const inputFocused = focusedPane === "input";
      const standardNav = config.navigationMode === "standard";

      if (matchesAction(event, config, "search", "close")) {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }

      if (matchesAction(event, config, "search", "clearSearch")) {
        event.preventDefault();
        event.stopPropagation();
        input.value = "";
        activeFilters = [];
        currentQuery = "";
        results = [];
        activeIndex = 0;
        updateTitle();
        updateFilterPills();
        renderResults();
        schedulePreviewUpdate();
        input.focus();
        setFocusedPane("input");
        return;
      }

      if (
        standardNav
        && !inputFocused
        && event.ctrlKey
        && !event.altKey
        && !event.metaKey
      ) {
        const lowerKey = event.key.toLowerCase();
        if (lowerKey === "d" || lowerKey === "u") {
          event.preventDefault();
          event.stopPropagation();
          if (results.length > 0) {
            const nextIndex = movePanelListIndexHalfPage(
              results.length,
              activeIndex,
              getHalfPageStep(),
              lowerKey === "d" ? "down" : "up",
            );
            setActiveIndex(nextIndex);
          }
          return;
        }
      }

      if (matchesAction(event, config, "search", "focusSearch") && !inputFocused) {
        event.preventDefault();
        event.stopPropagation();
        input.focus();
        setFocusedPane("input");
        return;
      }

      // Mirrors command-line UX: backspace on empty query removes last filter token.
      if (event.key === "Backspace" && focusedPane === "input"
          && input.value === "" && activeFilters.length > 0) {
        event.preventDefault();
        activeFilters.pop();
        input.value = activeFilters
          .map((filter) => `/${filter}`)
          .join(" ")
          + (activeFilters.length ? " " : "");
        updateTitle();
        updateFilterPills();
        results = [];
        currentQuery = "";
        renderResults();
        schedulePreviewUpdate();
        return;
      }

      if (matchesAction(event, config, "search", "switchPane")) {
        event.preventDefault();
        event.stopPropagation();
        if (inputFocused) {
          if (activeItemEl) {
            activeItemEl.focus();
          } else {
            const first = resultsList.querySelector(".ht-result-item") as HTMLElement;
            if (first) first.focus();
          }
          setFocusedPane("results");
        }
        return;
      }

      if (matchesAction(event, config, "search", "accept")) {
        event.preventDefault();
        event.stopPropagation();
        if (results[activeIndex]) jumpToResult(results[activeIndex]);
        return;
      }

      if (matchesAction(event, config, "search", "moveDown")) {
        const lowerKey = event.key.toLowerCase();
        if ((lowerKey === "j" || lowerKey === "k") && focusedPane === "input") return;
        event.preventDefault();
        event.stopPropagation();
        if (results.length > 0) {
          setActiveIndex(movePanelListIndexByDirection(results.length, activeIndex, "down"));
        }
        return;
      }
      if (matchesAction(event, config, "search", "moveUp")) {
        const lowerKey = event.key.toLowerCase();
        if ((lowerKey === "j" || lowerKey === "k") && focusedPane === "input") return;
        event.preventDefault();
        event.stopPropagation();
        if (results.length > 0) {
          setActiveIndex(movePanelListIndexByDirection(results.length, activeIndex, "up"));
        }
        return;
      }

      event.stopPropagation();
    }

    document.addEventListener("keydown", keyHandler, true);
    window.addEventListener("ht-navigation-mode-changed", onNavigationModeChanged);
    registerPanelCleanup(close);

    // Keep wheel navigation inside the panel instead of scrolling the host page.
    resultsPane.addEventListener("wheel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (results.length === 0) return;
      setActiveIndex(movePanelListIndexFromWheel(results.length, activeIndex, event.deltaY));
    });

    input.focus();
    setTimeout(() => { if (panelOpen) input.focus(); }, 50);

    // Restore previous query when reopening within the same page session.
    if (lastSearchState && lastSearchState.query) {
      input.value = lastSearchState.query;
      const { filters, query } = parseInput(lastSearchState.query);
      activeFilters = filters;
      updateTitle();
      if (query.length >= 2) {
        doGrep(query);
      }
    }
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open search current page:", err);
    dismissPanel();
  }
}
