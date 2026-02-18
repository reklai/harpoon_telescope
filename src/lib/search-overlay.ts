// Telescope search overlay — single-page search with structural filters.
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

import { matchesAction, keyToDisplay, saveKeybindings } from "./keybindings";
import { createPanelHost, removePanelHost, getBaseStyles, vimBadgeHtml } from "./panel-host";
import { escapeHtml, escapeRegex } from "./helpers";
import { grepPage, initLineCache, destroyLineCache } from "./grep";
import { scrollToText } from "./scroll";
import { showFeedback } from "./feedback";

// Page size limits — only block truly massive pages
const MAX_DOM_ELEMENTS = 200_000;
const MAX_TEXT_BYTES = 10 * 1024 * 1024; // 10 MB

// Valid slash commands that map to SearchFilter values
const VALID_FILTERS: Record<string, SearchFilter> = {
  "/code": "code",
  "/headings": "headings",
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
};
const DEFAULT_TAG_COLOR = { bg: "rgba(255,255,255,0.08)", fg: "#808080" };

// Virtual scrolling constants
const ITEM_HEIGHT = 28;    // px per result row (matches padding + font size)
const POOL_BUFFER = 5;     // extra items above/below viewport

// Ephemeral per-page state for resume
let lastSearchState: { query: string } | null = null;

export async function openTelescope(
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
    style.textContent =
      getBaseStyles() +
      `
      .ht-telescope-container {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 80vw; max-width: 960px; height: 70vh; max-height: 640px; min-height: 280px;
        background: #1e1e1e; border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
      }
      .ht-telescope-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
      .ht-telescope-input-wrap {
        display: flex; align-items: center; padding: 8px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06); background: #252525;
      }
      .ht-prompt { color: #0a84ff; margin-right: 8px; font-weight: 600; font-size: 14px; }
      .ht-telescope-input {
        flex: 1; background: transparent; border: none; outline: none;
        color: #e0e0e0; font-family: inherit; font-size: 13px;
        caret-color: #ffffff; caret-shape: block;
      }
      .ht-telescope-input::placeholder { color: #666; }
      .ht-telescope-columns { flex: 1; display: flex; overflow: hidden; }
      .ht-results-pane {
        width: 40%; border-right: 1px solid rgba(255,255,255,0.06);
        overflow-y: auto; position: relative;
      }
      .ht-results-sentinel {
        width: 100%; pointer-events: none;
      }
      .ht-results-list {
        position: absolute; top: 0; left: 0; right: 0;
        padding: 0;
      }
      .ht-result-item {
        padding: 5px 14px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.03);
        transition: background 0.1s; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; display: flex; align-items: baseline; gap: 6px;
        font-size: 12px; outline: none;
        height: ${ITEM_HEIGHT}px; box-sizing: border-box;
      }
      .ht-result-item:hover { background: rgba(255,255,255,0.06); }
      .ht-result-item.active {
        background: rgba(10,132,255,0.15); color: #fff;
        border-left: 2px solid #0a84ff;
      }
      .ht-result-tag {
        font-size: 9px; padding: 1px 4px; border-radius: 3px;
        font-weight: 600; flex-shrink: 0; letter-spacing: 0.3px;
      }
      .ht-result-text { flex: 1; overflow: hidden; text-overflow: ellipsis; }
      .ht-result-text mark {
        background: #f9d45c; color: #1e1e1e; border-radius: 2px; padding: 0 1px;
      }
      .ht-preview-pane {
        width: 60%; display: flex; flex-direction: column; overflow: hidden;
      }
      .ht-preview-header {
        padding: 5px 14px; font-size: 11px; color: #808080;
        background: #252525; border-bottom: 1px solid rgba(255,255,255,0.04);
        font-weight: 500;
      }
      .ht-preview-content {
        flex: 1; overflow-y: auto; padding: 12px 14px;
        font-family: inherit; font-size: 12px; line-height: 1.7;
        background: #1e1e1e; white-space: pre-wrap; word-wrap: break-word;
      }
      .ht-preview-line {
        color: #808080; display: block; padding: 1px 0;
      }
      .ht-preview-line.match {
        color: #e0e0e0; background: rgba(10,132,255,0.1);
        border-left: 2px solid #0a84ff; padding-left: 8px; margin-left: -10px;
      }
      .ht-preview-line .ht-line-num {
        display: inline-block; width: 36px; text-align: right;
        margin-right: 12px; color: #555; user-select: none;
      }
      .ht-preview-line.match .ht-line-num { color: #0a84ff; }
      .ht-preview-line mark {
        background: #f9d45c; color: #1e1e1e; border-radius: 2px; padding: 0 1px;
      }
      .ht-preview-breadcrumb {
        padding: 4px 14px; font-size: 10px; color: #808080;
        background: #252525; border-bottom: 1px solid rgba(255,255,255,0.04);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ht-preview-breadcrumb .ht-bc-heading {
        color: #32d74b; font-weight: 500;
      }
      .ht-preview-breadcrumb .ht-bc-tag {
        color: #af82ff; font-weight: 600; font-size: 9px;
        background: rgba(175,130,255,0.15); padding: 1px 4px; border-radius: 3px;
        margin-right: 4px;
      }
      .ht-preview-breadcrumb .ht-bc-href {
        color: #0a84ff; font-size: 10px; margin-left: 4px;
      }
      .ht-preview-code-ctx {
        background: #1a1a1a; border-radius: 4px; padding: 8px 0;
        margin: 4px 0; font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 11px; line-height: 1.5;
      }
      .ht-preview-code-ctx .ht-preview-line {
        padding: 1px 12px; font-family: inherit;
      }
      .ht-preview-code-ctx .ht-preview-line.match {
        background: rgba(10,132,255,0.12); padding-left: 10px;
      }
      .ht-preview-prose-ctx {
        padding: 4px 0; font-size: 12px; line-height: 1.7;
      }
      .ht-filter-pills {
        display: flex; gap: 6px; padding: 0 14px 6px; flex-wrap: wrap;
      }
      .ht-filter-pill {
        display: inline-flex; align-items: center; gap: 3px;
        background: rgba(10,132,255,0.15); color: #0a84ff;
        font-size: 10px; font-weight: 600; padding: 2px 8px;
        border-radius: 10px; user-select: none;
      }
      .ht-filter-pill-x {
        cursor: pointer; opacity: 0.6; font-size: 11px;
      }
      .ht-filter-pill-x:hover { opacity: 1; }
      .ht-titlebar-text {
        flex: 1; text-align: left; font-size: 12px; color: #e0e0e0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        display: flex; align-items: center; gap: 8px;
        margin-right: 0;
      }
      .ht-title-label { flex-shrink: 0; color: #a0a0a0; }
      .ht-title-sep { color: #555; flex-shrink: 0; }
      .ht-title-filters { color: #808080; font-size: 11px; flex-shrink: 0; }
      .ht-title-filter { color: #666; }
      .ht-title-filter.active { color: #0a84ff; font-weight: 600; }
      .ht-title-count { color: #808080; font-size: 11px; margin-left: auto; flex-shrink: 0; }
      .ht-preview-placeholder {
        flex: 1; display: flex; align-items: center; justify-content: center;
        color: #555; font-size: 14px; background: #1e1e1e;
      }
      .ht-no-results {
        padding: 24px; text-align: center; color: #808080; font-size: 12px;
      }
    `;
    shadow.appendChild(style);

    const wrapper = document.createElement("div");
    wrapper.innerHTML = `
      <div class="ht-backdrop"></div>
      <div class="ht-telescope-container">
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
              <span class="ht-title-filter" data-filter="links">/links</span>
            </span>
            <span class="ht-title-count"></span>
          </span>
          ${vimBadgeHtml(config)}
        </div>
        <div class="ht-telescope-body">
          <div class="ht-telescope-input-wrap">
            <span class="ht-prompt">&gt;</span>
            <input type="text" class="ht-telescope-input" placeholder="Search..." />
          </div>
          <div class="ht-filter-pills"></div>
          <div class="ht-telescope-columns">
            <div class="ht-results-pane">
              <div class="ht-results-sentinel"></div>
              <div class="ht-results-list"></div>
            </div>
            <div class="ht-preview-pane">
              <div class="ht-preview-header">Preview</div>
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
        <span>${upKey}/${downKey} j/k move</span>
        <span>${acceptKey} jump</span>
        <span>${switchKey} list</span>
        <span>${closeKey} close</span>
      </div>
    `;

    const input = shadow.querySelector(".ht-telescope-input") as HTMLInputElement;
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

    // rAF throttle for preview updates
    let previewRafId: number | null = null;

    // Virtual scrolling state
    let vsStart = 0;  // first visible result index
    let vsEnd = 0;    // last visible result index (exclusive)
    let itemPool: HTMLElement[] = []; // reusable DOM elements

    function close(): void {
      panelOpen = false;
      lastSearchState = { query: input.value };
      document.removeEventListener("keydown", keyHandler, true);
      if (previewRafId !== null) cancelAnimationFrame(previewRafId);
      destroyLineCache();
      removePanelHost();
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
      filterPills.innerHTML = activeFilters.map((f) =>
        `<span class="ht-filter-pill" data-filter="${f}">/${f}<span class="ht-filter-pill-x">\u00d7</span></span>`
      ).join("");
      // Click × to remove a filter from the input
      filterPills.querySelectorAll(".ht-filter-pill-x").forEach((x) => {
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          const pill = (x as HTMLElement).parentElement!;
          const filter = pill.dataset.filter!;
          // Remove this filter's slash command from the input
          const tokens = input.value.trimStart().split(/\s+/);
          const filtered = tokens.filter((t) => t !== `/${filter}`);
          input.value = filtered.join(" ");
          input.dispatchEvent(new Event("input"));
          input.focus();
        });
      });
    }

    function parseInput(raw: string): { filters: SearchFilter[]; query: string } {
      const tokens = raw.trimStart().split(/\s+/);
      const filters: SearchFilter[] = [];
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

    // -- Highlight --

    let highlightRegex: RegExp | null = null;

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
      const r = results[resultIdx];
      item.dataset.index = String(resultIdx);

      // Update badge
      const badge = item.firstElementChild as HTMLElement;
      if (r.tag) {
        const colors = TAG_COLORS[r.tag] || DEFAULT_TAG_COLOR;
        badge.style.background = colors.bg;
        badge.style.color = colors.fg;
        badge.textContent = r.tag;
        badge.style.display = "";
      } else {
        badge.style.display = "none";
      }

      // Update text
      const span = item.lastElementChild as HTMLElement;
      span.innerHTML = highlightMatch(r.text);

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
      const scrollTop = resultsPane.scrollTop;
      const viewHeight = resultsPane.clientHeight;

      const newStart = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - POOL_BUFFER);
      const newEnd = Math.min(results.length,
        Math.ceil((scrollTop + viewHeight) / ITEM_HEIGHT) + POOL_BUFFER);

      // Skip if range hasn't changed
      if (newStart === vsStart && newEnd === vsEnd) return;
      vsStart = newStart;
      vsEnd = newEnd;

      // Position the results list at the correct offset
      resultsList.style.top = `${vsStart * ITEM_HEIGHT}px`;

      // Ensure we have enough pool items
      const count = vsEnd - vsStart;

      // Detach excess items
      while (resultsList.children.length > count) {
        resultsList.removeChild(resultsList.lastChild!);
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
    }

    /** Full re-render after results change */
    function renderResults(): void {
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
    }

    // Scroll listener for virtual scrolling (passive for perf)
    resultsPane.addEventListener("scroll", () => {
      if (results.length > 0) renderVisibleItems();
    }, { passive: true });

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
      if (results.length === 0 || !results[activeIndex]) {
        previewHeader.textContent = "Preview";
        previewBreadcrumb.style.display = "none";
        showPreviewPlaceholder(true);
        return;
      }

      const r = results[activeIndex];
      const tag = r.tag || "";
      previewHeader.textContent = `Preview \u2014 L${r.lineNumber}`;
      showPreviewPlaceholder(false);

      // Breadcrumb: [TAG] Section heading · href
      let bcHtml = "";
      if (tag) bcHtml += `<span class="ht-bc-tag">${escapeHtml(tag)}</span>`;
      if (r.ancestorHeading) bcHtml += `<span class="ht-bc-heading">${escapeHtml(r.ancestorHeading)}</span>`;
      if (r.href) {
        // Show shortened href
        let displayHref = r.href;
        try { displayHref = new URL(r.href).pathname + new URL(r.href).hash; } catch (_) { /* noop */ }
        if (displayHref.length > 60) displayHref = displayHref.slice(0, 57) + "...";
        bcHtml += `<span class="ht-bc-href">\u2192 ${escapeHtml(displayHref)}</span>`;
      }
      if (bcHtml) {
        previewBreadcrumb.innerHTML = bcHtml;
        previewBreadcrumb.style.display = "";
      } else {
        previewBreadcrumb.style.display = "none";
      }

      // Use DOM-aware context if available, fall back to flat context
      const contextLines = r.domContext && r.domContext.length > 0
        ? r.domContext
        : r.context && r.context.length > 0
          ? r.context
          : [r.text];

      const isCode = tag === "PRE" || tag === "CODE";
      let html = "";

      if (isCode) {
        // Code block: monospace container with line numbers
        html += '<div class="ht-preview-code-ctx">';
        for (let i = 0; i < contextLines.length; i++) {
          const line = contextLines[i];
          const trimmed = line.replace(/\s+/g, " ").trim();
          const isMatch = trimmed === r.text || line.replace(/\s+/g, " ").trim() === r.text;
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
          const isMatch = line === r.text || line.replace(/\s+/g, " ").trim() === r.text;
          const cls = isMatch ? "ht-preview-line match" : "ht-preview-line";
          const lineContent = isMatch ? highlightMatch(line) : escapeHtml(line);
          html += `<span class="${cls}">${lineContent}</span>`;
        }
        html += '</div>';
      }

      previewContent.innerHTML = html;
      const matchLine = previewContent.querySelector(".match");
      if (matchLine) matchLine.scrollIntoView({ block: "center" });
    }

    // -- Event delegation on results list --

    resultsList.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest(".ht-result-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      setActiveIndex(Number(item.dataset.index));
    });

    resultsList.addEventListener("dblclick", (e) => {
      const item = (e.target as HTMLElement).closest(".ht-result-item") as HTMLElement | null;
      if (!item || !item.dataset.index) return;
      const idx = Number(item.dataset.index);
      activeIndex = idx;
      if (results[idx]) jumpToResult(results[idx]);
    });

    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (e) => e.preventDefault());

    // -- Search input --

    input.addEventListener("input", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      const { filters, query } = parseInput(input.value);
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
      debounceTimer = setTimeout(() => doGrep(query), 200);
    });

    function doGrep(query: string): void {
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
    }

    async function jumpToResult(result: GrepResult): Promise<void> {
      close();
      scrollToText(result.text, result.nodeRef);
    }

    // -- Keyboard handler --

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

      if (matchesAction(e, config, "search", "close")) {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }

      // Backspace on empty input removes the last active filter pill
      if (e.key === "Backspace" && host.shadowRoot?.activeElement === input
          && input.value === "" && activeFilters.length > 0) {
        e.preventDefault();
        activeFilters.pop();
        // Rebuild input text from remaining filters
        input.value = activeFilters.map((f) => `/${f}`).join(" ") + (activeFilters.length ? " " : "");
        updateTitle();
        updateFilterPills();
        // Re-trigger search with no query
        results = [];
        currentQuery = "";
        renderResults();
        schedulePreviewUpdate();
        return;
      }

      if (matchesAction(e, config, "search", "switchPane")) {
        e.preventDefault();
        e.stopPropagation();
        const shadowActive = host.shadowRoot?.activeElement;
        if (shadowActive === input) {
          if (activeItemEl) {
            activeItemEl.focus();
          } else {
            const first = resultsList.querySelector(".ht-result-item") as HTMLElement;
            if (first) first.focus();
          }
        } else {
          input.focus();
        }
        return;
      }

      if (matchesAction(e, config, "search", "accept")) {
        e.preventDefault();
        e.stopPropagation();
        if (results[activeIndex]) jumpToResult(results[activeIndex]);
        return;
      }

      const shadowActive = host.shadowRoot?.activeElement;
      const inputFocused = shadowActive === input;

      if (matchesAction(e, config, "search", "moveDown")) {
        const lk = e.key.toLowerCase();
        if ((lk === "j" || lk === "k") && inputFocused) return;
        e.preventDefault();
        e.stopPropagation();
        if (results.length > 0) {
          setActiveIndex(Math.min(activeIndex + 1, results.length - 1));
        }
        return;
      }
      if (matchesAction(e, config, "search", "moveUp")) {
        const lk = e.key.toLowerCase();
        if ((lk === "j" || lk === "k") && inputFocused) return;
        e.preventDefault();
        e.stopPropagation();
        if (results.length > 0) {
          setActiveIndex(Math.max(activeIndex - 1, 0));
        }
        return;
      }

      if (matchesAction(e, config, "search", "scrollPreviewUp")) {
        e.preventDefault();
        e.stopPropagation();
        previewContent.scrollTop -= previewContent.clientHeight * 0.5;
        return;
      }

      if (matchesAction(e, config, "search", "scrollPreviewDown")) {
        e.preventDefault();
        e.stopPropagation();
        previewContent.scrollTop += previewContent.clientHeight * 0.5;
        return;
      }

      e.stopPropagation();
    }

    document.addEventListener("keydown", keyHandler, true);

    // Mouse wheel on results pane: navigate items, block page scroll
    resultsPane.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (results.length === 0) return;
      if (e.deltaY > 0) {
        setActiveIndex(Math.min(activeIndex + 1, results.length - 1));
      } else {
        setActiveIndex(Math.max(activeIndex - 1, 0));
      }
    });

    // Mouse wheel on preview pane: scroll content, block page scroll
    previewPane.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      previewContent.scrollTop += e.deltaY;
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
    console.error("[Harpoon Telescope] Failed to open telescope:", err);
  }
}
