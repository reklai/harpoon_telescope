// Search Open Tabs overlay — sorted list of all open tabs with fuzzy filter.
// Alt+Shift+F to open, type to filter, Tab to cycle input/results, Enter to jump.

import { matchesAction, keyToDisplay } from "../../../common/contracts/keybindings";
import {
  createPanelHost,
  removePanelHost,
  registerPanelCleanup,
  getBaseStyles,
  footerRowHtml,
  vimBadgeHtml,
  dismissPanel,
} from "../../../common/utils/panelHost";
import { escapeHtml, escapeRegex, extractDomain, buildFuzzyPattern } from "../../../common/utils/helpers";
import { withPerfTrace } from "../../../common/utils/perf";
import searchOpenTabsStyles from "./searchOpenTabs.css";
import { listFrecencyEntriesWithRetry, switchToTabById } from "../../../adapters/runtime/openTabsApi";
import {
  movePanelListIndexByDirection,
  movePanelListIndexFromWheel,
  movePanelListIndexHalfPage,
} from "../../../core/panel/panelListController";

export async function openSearchOpenTabs(
  config: KeybindingsConfig,
): Promise<void> {
  try {
    const { host, shadow } = createPanelHost();
    let panelOpen = true;

    // --- Keybind display strings ---
    const upKey = keyToDisplay(config.bindings.search.moveUp.key);
    const downKey = keyToDisplay(config.bindings.search.moveDown.key);
    const switchPaneKey = keyToDisplay(config.bindings.search.switchPane.key);
    const focusSearchKey = keyToDisplay(config.bindings.search.focusSearch.key);
    const clearSearchKey = keyToDisplay(config.bindings.search.clearSearch.key);
    const acceptKey = keyToDisplay(config.bindings.search.accept.key);
    const closeKey = keyToDisplay(config.bindings.search.close.key);
    function renderFooter(): void {
      const navHints = config.navigationMode === "standard"
        ? [
          { key: "j/k", desc: "nav" },
          { key: `${upKey}/${downKey}`, desc: "nav" },
          { key: "Ctrl+D/U", desc: "half-page" },
        ]
        : [
          { key: `${upKey}/${downKey}`, desc: "nav" },
        ];
      footer.innerHTML = `${footerRowHtml(navHints)}
      ${footerRowHtml([
        { key: switchPaneKey, desc: "list" },
        { key: focusSearchKey, desc: "search" },
        { key: clearSearchKey, desc: "clear-search" },
        { key: acceptKey, desc: "jump" },
        { key: closeKey, desc: "close" },
      ])}`;
    }

    function onNavigationModeChanged(): void {
      renderFooter();
    }

    const style = document.createElement("style");
    style.textContent = getBaseStyles() + searchOpenTabsStyles;
    shadow.appendChild(style);

    // --- Build static shell (only once) ---
    const backdrop = document.createElement("div");
    backdrop.className = "ht-backdrop";
    shadow.appendChild(backdrop);

    const panel = document.createElement("div");
    panel.className = "ht-open-tabs-container";
    shadow.appendChild(panel);

    // Title bar
    const titlebar = document.createElement("div");
    titlebar.className = "ht-titlebar";
    titlebar.innerHTML = `
      <div class="ht-traffic-lights">
        <button class="ht-dot ht-dot-close" title="Close (${escapeHtml(closeKey)})"></button>
      </div>
      <span class="ht-titlebar-text">Search Open Tabs</span>
      ${vimBadgeHtml(config)}`;
    panel.appendChild(titlebar);

    const titleText = titlebar.querySelector(".ht-titlebar-text") as HTMLElement;

    // Input row
    const inputWrap = document.createElement("div");
    inputWrap.className = "ht-open-tabs-input-wrap ht-ui-input-wrap";
    inputWrap.innerHTML = `<span class="ht-open-tabs-prompt ht-ui-input-prompt">&gt;</span>`;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ht-open-tabs-input ht-ui-input-field";
    input.placeholder = "Search Open Tabs . . .";
    inputWrap.appendChild(input);
    panel.appendChild(inputWrap);

    // Results list
    const listEl = document.createElement("div");
    listEl.className = "ht-open-tabs-list";
    panel.appendChild(listEl);

    // Footer
    const footer = document.createElement("div");
    footer.className = "ht-footer";
    renderFooter();
    panel.appendChild(footer);

    let allEntries: FrecencyEntry[] = [];
    let filtered: FrecencyEntry[] = [];
    let activeIndex = 0;
    let query = "";
    let activeItemEl: HTMLElement | null = null;
    let highlightRegex: RegExp | null = null;
    let inputRafId: number | null = null;
    let pendingInputValue = "";

    function close(): void {
      panelOpen = false;
      document.removeEventListener("keydown", keyHandler, true);
      window.removeEventListener("ht-navigation-mode-changed", onNavigationModeChanged);
      if (inputRafId !== null) cancelAnimationFrame(inputRafId);
      cancelAnimationFrame(renderRafId);
      removePanelHost();
    }

    function failClose(context: string, error: unknown): void {
      console.error(`[Harpoon Telescope] ${context}; dismissing panel.`, error);
      close();
    }

    function buildHighlightRegex(): void {
      const terms = query.trim().split(/\s+/).filter(Boolean);
      if (terms.length === 0) {
        highlightRegex = null;
        return;
      }
      const pattern = terms
        .map((t) => `(${escapeRegex(escapeHtml(t))})`)
        .join("|");
      try {
        highlightRegex = new RegExp(pattern, "gi");
      } catch (_) {
        highlightRegex = null;
      }
    }

    /** Highlight fuzzy query matches in text */
    function highlightMatch(text: string): string {
      const escaped = escapeHtml(text);
      if (!highlightRegex) return escaped;
      return escaped.replace(highlightRegex, "<mark>$1</mark>");
    }

    let renderRafId = 0;
    let firstRender = true;

    function processInputValue(rawValue: string): void {
      query = rawValue;
      buildHighlightRegex();
      applyFilter();
      renderList();
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
          console.error("[Harpoon Telescope] Open-tabs input processing failed; dismissing panel.", error);
          close();
        }
      });
    }

    /** Build list items into a DocumentFragment */
    function buildListFragment(): DocumentFragment {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < filtered.length; i++) {
        const entry = filtered[i];
        const shortUrl = extractDomain(entry.url);
        const item = document.createElement("div");
        item.className = i === activeIndex ? "ht-open-tabs-item active" : "ht-open-tabs-item";
        item.dataset.index = String(i);
        item.dataset.tabId = String(entry.tabId);
        item.tabIndex = -1;

        const score = document.createElement("span");
        score.className = "ht-open-tabs-score";
        score.textContent = String(entry.frecencyScore);

        const info = document.createElement("div");
        info.className = "ht-open-tabs-info";

        const title = document.createElement("div");
        title.className = "ht-open-tabs-title";
        title.innerHTML = highlightMatch(entry.title || "Untitled");

        const url = document.createElement("div");
        url.className = "ht-open-tabs-url";
        url.textContent = shortUrl;

        info.appendChild(title);
        info.appendChild(url);
        item.appendChild(score);
        item.appendChild(info);
        frag.appendChild(item);
      }
      return frag;
    }

    /** Flush fragment into the list and update activeItemEl */
    function commitList(frag: DocumentFragment): void {
      listEl.textContent = "";
      listEl.appendChild(frag);
      activeItemEl = listEl.children[activeIndex] as HTMLElement | null;
      if (activeItemEl) activeItemEl.scrollIntoView({ block: "nearest" });
    }

    /** Full rebuild of the results list (called when filtered data changes) */
    function renderList(): void {
      try {
        titleText.textContent = query
          ? `Search Open Tabs (${filtered.length})`
          : "Search Open Tabs";

        if (filtered.length === 0) {
          cancelAnimationFrame(renderRafId);
          listEl.innerHTML = `<div class="ht-open-tabs-empty">${
            query ? "No matching tabs" : "No open tabs"
          }</div>`;
          activeItemEl = null;
          return;
        }

        if (firstRender) {
          firstRender = false;
          commitList(buildListFragment());
          return;
        }

        // Debounce subsequent renders to one paint via rAF
        cancelAnimationFrame(renderRafId);
        renderRafId = requestAnimationFrame(() => {
          if (!panelOpen) return;
          try {
            commitList(buildListFragment());
          } catch (error) {
            failClose("Open-tabs render commit failed", error);
          }
        });
      } catch (error) {
        failClose("Open-tabs render failed", error);
      }
    }

    /** Move active highlight without rebuilding DOM */
    function updateActiveHighlight(newIndex: number): void {
      if (newIndex === activeIndex && activeItemEl) return;
      // Remove old highlight
      if (activeItemEl) activeItemEl.classList.remove("active");
      activeIndex = newIndex;
      // Apply new highlight
      activeItemEl = (listEl.children[activeIndex] as HTMLElement) || null;
      if (activeItemEl) {
        activeItemEl.classList.add("active");
        activeItemEl.scrollIntoView({ block: "nearest" });
      }
    }

    function onListClick(event: Event): void {
      const item = (event.target as HTMLElement).closest(".ht-open-tabs-item") as HTMLElement;
      if (!item) return;
      const idx = parseInt(item.dataset.index!);
      if (filtered[idx]) jumpToTab(filtered[idx]);
    }

    // --- Filtering ---
    // 4-tier match scoring: exact (0) > starts-with (1) > substring (2) > fuzzy (3)
    // Returns -1 for no match.
    function scoreMatch(
      lowerText: string,
      rawText: string,
      queryLower: string,
      fuzzyRe: RegExp,
    ): number {
      if (lowerText === queryLower) return 0;            // exact match
      if (lowerText.startsWith(queryLower)) return 1;    // starts-with
      if (lowerText.includes(queryLower)) return 2;      // substring
      if (fuzzyRe.test(rawText)) return 3;               // fuzzy only
      return -1;                                         // no match
    }

    function applyFilter(): void {
      try {
        withPerfTrace("searchOpenTabs.applyFilter", () => {
          const trimmedQuery = query.trim();
          if (!trimmedQuery) {
            filtered = [...allEntries];
            activeIndex = 0;
            return;
          }

          const re = buildFuzzyPattern(trimmedQuery);
          const substringRe = new RegExp(escapeRegex(trimmedQuery), "i");

          if (!re) {
            filtered = [...allEntries];
            activeIndex = 0;
            return;
          }

          const queryLower = trimmedQuery.toLowerCase();
          const ranked: Array<{
            entry: FrecencyEntry;
            titleScore: number;
            titleHit: boolean;
            titleLen: number;
            urlScore: number;
            urlHit: boolean;
          }> = [];

          // Two-pass: substring first, fuzzy as fallback
          for (const entry of allEntries) {
            const title = entry.title || "";
            const url = entry.url || "";
            if (!(substringRe.test(title) || substringRe.test(url) || re.test(title) || re.test(url))) {
              continue;
            }

            const titleScore = scoreMatch(title.toLowerCase(), title, queryLower, re);
            const urlScore = scoreMatch(url.toLowerCase(), url, queryLower, re);
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
            if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
            if (a.titleHit && b.titleHit) {
              if (a.titleScore !== b.titleScore) return a.titleScore - b.titleScore;
              return a.titleLen - b.titleLen;
            }
            if (a.urlHit !== b.urlHit) return a.urlHit ? -1 : 1;
            if (a.urlHit && b.urlHit) return a.urlScore - b.urlScore;
            return 0;
          });

          filtered = ranked.map((r) => r.entry);
          activeIndex = 0;
        });
      } catch (error) {
        failClose("Open-tabs filtering failed", error);
      }
    }

    async function jumpToTab(entry: FrecencyEntry): Promise<void> {
      if (!entry) return;
      close();
      await switchToTabById(entry.tabId);
    }

    function getHalfPageStep(): number {
      const first = listEl.querySelector(".ht-open-tabs-item") as HTMLElement | null;
      const itemHeight = Math.max(1, (first?.offsetHeight ?? activeItemEl?.offsetHeight ?? 36));
      const viewportRows = Math.max(1, Math.floor(listEl.clientHeight / itemHeight));
      return Math.max(1, Math.floor(viewportRows / 2));
    }

    function keyHandler(event: KeyboardEvent): void {
      if (!panelOpen || !document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      const inputFocused = host.shadowRoot?.activeElement === input;
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
        query = "";
        buildHighlightRegex();
        applyFilter();
        renderList();
        input.focus();
        listEl.classList.remove("focused");
        return;
      }

      // Switch-pane key cycles between input and results list (only if results exist).
      if (matchesAction(event, config, "search", "switchPane")) {
        event.preventDefault();
        event.stopPropagation();
        if (filtered.length === 0) return;
        if (inputFocused) {
          if (activeItemEl) {
            activeItemEl.focus();
          } else {
            const first = listEl.querySelector(".ht-open-tabs-item") as HTMLElement;
            if (first) first.focus();
          }
          listEl.classList.add("focused");
        }
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
          if (filtered.length > 0) {
            const nextIndex = movePanelListIndexHalfPage(
              filtered.length,
              activeIndex,
              getHalfPageStep(),
              lowerKey === "d" ? "down" : "up",
            );
            updateActiveHighlight(nextIndex);
            if (activeItemEl) activeItemEl.focus();
          }
          return;
        }
      }

      if (matchesAction(event, config, "search", "focusSearch") && !inputFocused) {
        event.preventDefault();
        event.stopPropagation();
        input.focus();
        listEl.classList.remove("focused");
        return;
      }

      if (matchesAction(event, config, "search", "accept")) {
        event.preventDefault();
        event.stopPropagation();
        if (filtered[activeIndex]) jumpToTab(filtered[activeIndex]);
        return;
      }

      if (matchesAction(event, config, "search", "moveDown")) {
        const lk = event.key.toLowerCase();
        if ((lk === "j" || lk === "k") && inputFocused) return;
        event.preventDefault();
        event.stopPropagation();
        if (filtered.length > 0) {
          updateActiveHighlight(movePanelListIndexByDirection(filtered.length, activeIndex, "down"));
          if (!inputFocused && activeItemEl) activeItemEl.focus();
        }
        return;
      }

      if (matchesAction(event, config, "search", "moveUp")) {
        const lk = event.key.toLowerCase();
        if ((lk === "j" || lk === "k") && inputFocused) return;
        event.preventDefault();
        event.stopPropagation();
        if (filtered.length > 0) {
          updateActiveHighlight(movePanelListIndexByDirection(filtered.length, activeIndex, "up"));
          if (!inputFocused && activeItemEl) activeItemEl.focus();
        }
        return;
      }

      // Block all other keys from reaching the page
      event.stopPropagation();
    }

    // Bind static events
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (event) => event.preventDefault());
    titlebar.querySelector(".ht-dot-close")!.addEventListener("click", close);
    listEl.addEventListener("click", onListClick);

    // Mouse wheel on results list: navigate items, block page scroll
    listEl.addEventListener("wheel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (filtered.length === 0) return;
      updateActiveHighlight(movePanelListIndexFromWheel(filtered.length, activeIndex, event.deltaY));
    });

    // Sync focused state on mouse clicks
    input.addEventListener("focus", () => { listEl.classList.remove("focused"); });
    listEl.addEventListener("focus", () => { listEl.classList.add("focused"); }, true);

    input.addEventListener("input", () => {
      scheduleInputProcessing(input.value);
    });

    window.addEventListener("ht-navigation-mode-changed", onNavigationModeChanged);

    // Fetch frecency list and render
    allEntries = await listFrecencyEntriesWithRetry();
    filtered = [...allEntries];

    document.addEventListener("keydown", keyHandler, true);
    registerPanelCleanup(close);
    renderList();
    input.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open search open tabs:", err);
    dismissPanel();
  }
}
