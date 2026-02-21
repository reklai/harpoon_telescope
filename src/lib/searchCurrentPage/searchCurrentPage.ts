// Search Current Page overlay — single-page search with structural filters.
// Supports combinable slash-command filters: /code, /headings, /links.
// Always uses fuzzy matching. Results show element type badges with
// color coding. Match count displayed in title bar.
//
// Performance:
//  - Virtual scrolling: only ~25 DOM items rendered, recycled on scroll
//  - Event delegation: single click/dblclick on results container
//  - rAF-throttled preview updates for smooth rapid navigation
//  - Line cache: DOM only walked once, re-filtered from cache on keystrokes
//  - Direct DOM refs: no querySelector for active item toggling

import { matchesAction, keyToDisplay } from "../shared/keybindings";
import {
  createPanelHost,
  removePanelHost,
  registerPanelCleanup,
  getBaseStyles,
  vimBadgeHtml,
  dismissPanel,
} from "../shared/panelHost";
import { escapeHtml, escapeRegex } from "../shared/helpers";
import { parseSlashFilterQuery } from "../shared/filterInput";
import { grepPage, enrichResult, initLineCache, destroyLineCache } from "./grep";
import { scrollToText } from "../shared/scroll";
import { showFeedback } from "../shared/feedback";
import { withPerfTrace } from "../shared/perf";
import searchCurrentPageStyles from "./searchCurrentPage.css";

// Page size limits — only block truly massive pages
const MAX_DOM_ELEMENTS = 200_000;
const MAX_TEXT_BYTES = 10 * 1024 * 1024; // 10 MB

// Valid slash commands that map to SearchFilter values
const VALID_FILTERS: Record<string, SearchFilter> = {
  "/code": "code",
  "/headings": "headings",
  "/img": "images",
  "/links": "links",
};

// Badge colors by element tag category
const TAG_COLORS: Record<string, { bg: string; fg: string }> = {
  PRE:  { bg: "rgba(175,130,255,0.2)", fg: "#af82ff" },
  CODE: { bg: "rgba(175,130,255,0.2)", fg: "#af82ff" },
  H1: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  H2: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  H3: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  H4: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  H5: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  H6: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  A: { bg: "rgba(255,159,10,0.2)", fg: "#ff9f0a" },
  IMG: { bg: "rgba(0,199,190,0.2)", fg: "#00c7be" },
};
const DEFAULT_TAG_COLOR = { bg: "rgba(255,255,255,0.08)", fg: "#808080" };

// Virtual scrolling constants
const ITEM_HEIGHT = 28;    // px per result row (hardcoded in searchCurrentPage.css)
const POOL_BUFFER = 5;     // extra items above/below viewport

// Ephemeral per-page state for resume
let lastSearchState: { query: string } | null = null;

export async function openSearchCurrentPage(
  config: KeybindingsConfig,
): Promise<void> {
  try {
    // Init line cache before building UI (starts MutationObserver)
    initLineCache();

    // Page size safety guard — bail on extremely large pages
    const elementCount = document.body.querySelectorAll("*").length;
    const textLength = document.body.textContent?.length ?? 0;
    if (elementCount > MAX_DOM_ELEMENTS || textLength > MAX_TEXT_BYTES) {
      destroyLineCache();
      showFeedback("Page too large to search");
      return;
    }

    const { host, shadow } = createPanelHost();
    let panelOpen = true;

    const style = document.createElement("style");
    style.textContent = getBaseStyles() + searchCurrentPageStyles;
    shadow.appendChild(style);

    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div class="ht-backdrop"></div>
      <div class="ht-search-page-container">
        <div class="ht-titlebar">
          <div class="ht-traffic-lights">
            <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
          </div>
          <span class="ht-titlebar-text">
            <span class="ht-title-label">Search — Current Page</span>
            <span class="ht-title-sep">|</span>
            <span class="ht-title-filters">Filters:
              <span class="ht-title-filter" data-filter="code">/code</span>
              <span class="ht-title-filter" data-filter="headings">/headings</span>
              <span class="ht-title-filter" data-filter="images">/img</span>
              <span class="ht-title-filter" data-filter="links">/links</span>
            </span>
            <span class="ht-title-count"></span>
          </span>
          ${vimBadgeHtml(config)}
        </div>
        <div class="ht-search-page-body">
          <div class="ht-search-page-input-wrap ht-ui-input-wrap">
            <span class="ht-prompt ht-ui-input-prompt">&gt;</span>
            <input type="text" class="ht-search-page-input ht-ui-input-field" placeholder="Search..." />
          </div>
          <div class="ht-filter-pills"></div>
          <div class="ht-search-page-columns">
            <div class="ht-results-pane">
              <div class="ht-results-sentinel"></div>
              <div class="ht-results-list"></div>
            </div>
            <div class="ht-preview-pane">
              <div class="ht-preview-header ht-ui-pane-header">Preview</div>
              <div class="ht-preview-breadcrumb" style="display:none;"></div>
              <div class="ht-preview-placeholder">Select a result to preview</div>
              <div class="ht-preview-content" style="display:none;"></div>
            </div>
          </div>
          <div class="ht-footer"></div>
        </div>
      </div>
    `;
    shadow.appendChild(wrapper);

    // Build footer hints
    const footer = shadow.querySelector(".ht-footer") as HTMLElement;
    const upKey = keyToDisplay(config.bindings.search.moveUp.key);
    const downKey = keyToDisplay(config.bindings.search.moveDown.key);
    const acceptKey = keyToDisplay(config.bindings.search.accept.key);
    const switchKey = keyToDisplay(config.bindings.search.switchPane.key);
    const closeKey = keyToDisplay(config.bindings.search.close.key);
    footer.innerHTML = `
      <div class="ht-footer-row">
        <span>j/k (vim) ${upKey}/${downKey} nav</span>
        <span>${switchKey} list</span>
        <span>C clear</span>
        <span>${acceptKey} jump</span>
        <span>${closeKey} close</span>
      </div>
    `;

    const input = shadow.querySelector(".ht-search-page-input") as HTMLInputElement;
    const resultsList = shadow.querySelector(".ht-results-list") as HTMLElement;
    const resultsSentinel = shadow.querySelector(".ht-results-sentinel") as HTMLElement;
    const previewHeader = shadow.querySelector(".ht-preview-header") as HTMLElement;
    const previewBreadcrumb = shadow.querySelector(".ht-preview-breadcrumb") as HTMLElement;
    const previewPane = shadow.querySelector(".ht-preview-pane") as HTMLElement;
    const previewPlaceholder = shadow.querySelector(".ht-preview-placeholder") as HTMLElement;
    const previewContent = shadow.querySelector(".ht-preview-content") as HTMLElement;
    const filterPills = shadow.querySelector(".ht-filter-pills") as HTMLElement;
    const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;
    const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
    const resultsPane = shadow.querySelector(".ht-results-pane") as HTMLElement;
    const titleText = shadow.querySelector(".ht-titlebar-text") as HTMLElement;
    const titleFilterSpans = shadow.querySelectorAll(".ht-title-filter") as NodeListOf<HTMLElement>;
    const titleCount = shadow.querySelector(".ht-title-count") as HTMLElement;

    let results: GrepResult[] = [];
    let activeIndex = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let currentQuery = "";
    let activeFilters: SearchFilter[] = [];
    let activeItemEl: HTMLElement | null = null; // direct ref, no querySelector
    let focusedPane: "input" | "results" = "input"; // tracks which pane has focus

    function setFocusedPane(pane: "input" | "results"): void {
      focusedPane = pane;
      resultsPane.classList.toggle("focused", pane === "results");
    }

    // rAF throttle for preview updates
    let previewRafId: number | null = null;
    let scrollRafId: number | null = null;
    let inputRafId: number | null = null;
    let pendingInputValue = "";

    // Virtual scrolling state
    let vsStart = 0;  // first visible result index
    let vsEnd = 0;    // last visible result index (exclusive)
    let itemPool: HTMLElement[] = []; // reusable DOM elements

    function close(): void {
      panelOpen = false;
      lastSearchState = { query: input.value };
      document.removeEventListener("keydown", keyHandler, true);
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
      // Highlight active filter spans
      titleFilterSpans.forEach((span) => {
        const filter = span.dataset.filter as SearchFilter;
        span.classList.toggle("active", activeFilters.includes(filter));
      });
      // Update match count
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
      // Click × to remove a filter from the input
      filterPills.querySelectorAll(".ht-filter-pill-x").forEach((removeButton) => {
        removeButton.addEventListener("click", (event) => {
          event.stopPropagation();
          const pill = (removeButton as HTMLElement).parentElement!;
          const filter = pill.dataset.filter!;
          // Remove this filter's slash command from the input
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

    // -- Highlight --

    let highlightRegex: RegExp | null = null;

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

    // -- Virtual scrolling --

    /** Get or create a pooled result item element */
    function getPoolItem(poolIdx: number): HTMLElement {
      if (poolIdx < itemPool.length) return itemPool[poolIdx];
      const item = document.createElement("div");
      item.className = "ht-result-item";
      item.tabIndex = -1;
      // Badge span (reused, shown/hidden per item)
      const badge = document.createElement("span");
      badge.className = "ht-result-tag";
      item.appendChild(badge);
      // Text span
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

      // Update badge
      const badge = item.firstElementChild as HTMLElement;
      if (result.tag) {
        const colors = TAG_COLORS[result.tag] || DEFAULT_TAG_COLOR;
        badge.style.background = colors.bg;
        badge.style.color = colors.fg;
        badge.textContent = result.tag;
        badge.style.display = "";
      } else {
        badge.style.display = "none";
      }

      // Update text
      const span = item.lastElementChild as HTMLElement;
      span.innerHTML = highlightMatch(result.text);

      // Active state
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

          // Skip if range hasn't changed
          if (newStart === vsStart && newEnd === vsEnd) return;
          vsStart = newStart;
          vsEnd = newEnd;

          // Position the results list at the correct offset
          resultsList.style.top = `${vsStart * ITEM_HEIGHT}px`;

          // Ensure we have enough pool items
          const count = Math.max(0, vsEnd - vsStart);

          // Detach excess items
          while (resultsList.children.length > count) {
            const last = resultsList.lastChild;
            if (!last) break;
            resultsList.removeChild(last);
          }

          // Bind and attach items
          activeItemEl = null;
          for (let i = 0; i < count; i++) {
            const item = getPoolItem(i);
            bindPoolItem(item, vsStart + i);
            if (i < resultsList.children.length) {
              // Item already in DOM at this slot — just re-bind (already done above)
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
          buildHighlightRegex();

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

          // Set sentinel height for correct scrollbar
          resultsSentinel.style.height = `${results.length * ITEM_HEIGHT}px`;

          // Reset scroll and render visible window
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

    // Scroll listener for virtual scrolling (passive for perf)
    resultsPane.addEventListener("scroll", scheduleVisibleRender, { passive: true });

    function setActiveIndex(newIndex: number): void {
      if (newIndex < 0 || newIndex >= results.length) return;
      if (newIndex === activeIndex && activeItemEl) {
        schedulePreviewUpdate();
        return;
      }

      // Remove active from previous (direct ref, no querySelector)
      if (activeItemEl) activeItemEl.classList.remove("active");

      activeIndex = newIndex;

      // Find new active in current virtual window
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
      // Compute where the active item should be and scroll the pane
      const itemTop = activeIndex * ITEM_HEIGHT;
      const itemBottom = itemTop + ITEM_HEIGHT;
      const scrollTop = resultsPane.scrollTop;
      const viewHeight = resultsPane.clientHeight;

      if (itemTop < scrollTop) {
        resultsPane.scrollTop = itemTop;
      } else if (itemBottom > scrollTop + viewHeight) {
        resultsPane.scrollTop = itemBottom - viewHeight;
      }
      // scrollTop change will trigger the passive scroll listener -> renderVisibleItems
    }

    // -- Preview with rAF throttle --

    function showPreviewPlaceholder(show: boolean): void {
      previewPlaceholder.style.display = show ? "flex" : "none";
      previewContent.style.display = show ? "none" : "block";
      previewBreadcrumb.style.display = show ? "none" : "";
    }

    function schedulePreviewUpdate(): void {
      if (previewRafId !== null) return; // already scheduled
      previewRafId = requestAnimationFrame(() => {
        previewRafId = null;
        updatePreview();
      });
    }

    function updatePreview(): void {
      try {
        if (results.length === 0 || !results[activeIndex]) {
          previewHeader.textContent = "Preview";
          previewBreadcrumb.style.display = "none";
          showPreviewPlaceholder(true);
          return;
        }

        const activeResult = results[activeIndex];
        enrichResult(activeResult); // lazy: compute domContext/ancestorHeading/href on demand
        const tag = activeResult.tag || "";
        previewHeader.textContent = `Preview \u2014 L${activeResult.lineNumber}`;
        showPreviewPlaceholder(false);

        // Breadcrumb: [TAG] Section heading · href
        let breadcrumbHtml = "";
        if (tag) breadcrumbHtml += `<span class="ht-bc-tag">${escapeHtml(tag)}</span>`;
        if (activeResult.ancestorHeading) {
          breadcrumbHtml += `<span class="ht-bc-heading">${escapeHtml(activeResult.ancestorHeading)}</span>`;
        }
        if (activeResult.href) {
          // Show shortened href
          let displayHref = activeResult.href;
          try {
            displayHref = new URL(activeResult.href).pathname + new URL(activeResult.href).hash;
          } catch (_) {
            // Ignore URL parsing failures and keep raw href
          }
          if (displayHref.length > 60) displayHref = displayHref.slice(0, 57) + "...";
          breadcrumbHtml += `<span class="ht-bc-href">\u2192 ${escapeHtml(displayHref)}</span>`;
        }
        if (breadcrumbHtml) {
          previewBreadcrumb.innerHTML = breadcrumbHtml;
          previewBreadcrumb.style.display = "";
        } else {
          previewBreadcrumb.style.display = "none";
        }

        // Use DOM-aware context if available, fall back to flat context
        const contextLines = activeResult.domContext && activeResult.domContext.length > 0
          ? activeResult.domContext
          : activeResult.context && activeResult.context.length > 0
            ? activeResult.context
            : [activeResult.text];

        const isCode = tag === "PRE" || tag === "CODE";
        let html = "";

        if (isCode) {
          // Code block: monospace container with line numbers
          html += '<div class="ht-preview-code-ctx">';
          for (let i = 0; i < contextLines.length; i++) {
            const line = contextLines[i];
            const trimmed = line.replace(/\s+/g, " ").trim();
            const isMatch = (
              trimmed === activeResult.text
              || line.replace(/\s+/g, " ").trim() === activeResult.text
            );
            const cls = isMatch ? "ht-preview-line match" : "ht-preview-line";
            const lineContent = isMatch ? highlightMatch(line) : escapeHtml(line);
            html += `<span class="${cls}"><span class="ht-line-num">${i + 1}</span>${lineContent}</span>`;
          }
          html += '</div>';
        } else {
          // Prose: clean text blocks
          html += '<div class="ht-preview-prose-ctx">';
          for (let i = 0; i < contextLines.length; i++) {
            const line = contextLines[i];
            const isMatch = (
              line === activeResult.text
              || line.replace(/\s+/g, " ").trim() === activeResult.text
            );
            const cls = isMatch ? "ht-preview-line match" : "ht-preview-line";
            const lineContent = isMatch ? highlightMatch(line) : escapeHtml(line);
            html += `<span class="${cls}">${lineContent}</span>`;
          }
          html += '</div>';
        }

        previewContent.innerHTML = html;
        const matchLine = previewContent.querySelector(".match");
        if (matchLine) matchLine.scrollIntoView({ block: "center" });
      } catch (error) {
        failClose("Page-search preview render failed", error);
      }
    }

    // -- Event delegation on results list --

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

    // Sync focusedPane on mouse clicks
    input.addEventListener("focus", () => { setFocusedPane("input"); });
    resultsList.addEventListener("focus", () => { setFocusedPane("results"); }, true);

    // -- Search input --

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

    // -- Keyboard handler --

    function keyHandler(event: KeyboardEvent): void {
      if (!panelOpen) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

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
        input.value = activeFilters
          .map((filter) => `/${filter}`)
          .join(" ")
          + (activeFilters.length ? " " : "");
        updateTitle();
        updateFilterPills();
        // Re-trigger search with no query
        results = [];
        currentQuery = "";
        renderResults();
        schedulePreviewUpdate();
        return;
      }

      if (matchesAction(event, config, "search", "switchPane")) {
        event.preventDefault();
        event.stopPropagation();
        if (focusedPane === "input") {
          if (activeItemEl) {
            activeItemEl.focus();
          } else {
            const first = resultsList.querySelector(".ht-result-item") as HTMLElement;
            if (first) first.focus();
          }
          setFocusedPane("results");
        } else {
          input.focus();
          setFocusedPane("input");
        }
        return;
      }

      // Clear search: c/C (case-insensitive, only when results pane is focused)
      if (event.key.toLowerCase() === "c" && !event.ctrlKey && !event.altKey && !event.metaKey
          && focusedPane === "results") {
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
          setActiveIndex(Math.min(activeIndex + 1, results.length - 1));
        }
        return;
      }
      if (matchesAction(event, config, "search", "moveUp")) {
        const lowerKey = event.key.toLowerCase();
        if ((lowerKey === "j" || lowerKey === "k") && focusedPane === "input") return;
        event.preventDefault();
        event.stopPropagation();
        if (results.length > 0) {
          setActiveIndex(Math.max(activeIndex - 1, 0));
        }
        return;
      }

      event.stopPropagation();
    }

    document.addEventListener("keydown", keyHandler, true);
    registerPanelCleanup(close);

    // Mouse wheel on results pane: navigate items, block page scroll
    resultsPane.addEventListener("wheel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (results.length === 0) return;
      if (event.deltaY > 0) {
        setActiveIndex(Math.min(activeIndex + 1, results.length - 1));
      } else {
        setActiveIndex(Math.max(activeIndex - 1, 0));
      }
    });

    // Focus input
    input.focus();
    setTimeout(() => { if (panelOpen) input.focus(); }, 50);

    // Restore previous search state
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
