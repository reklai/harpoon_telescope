// Search Open Tabs overlay — sorted list of all open tabs with fuzzy filter.
// Alt+Shift+F to open, type to filter, Tab to cycle input/results, Enter to jump.

import browser from "webextension-polyfill";
import { matchesAction, keyToDisplay } from "../shared/keybindings";
import { createPanelHost, removePanelHost, registerPanelCleanup, getBaseStyles, vimBadgeHtml } from "../shared/panelHost";
import { escapeHtml, escapeRegex, extractDomain, buildFuzzyPattern } from "../shared/helpers";
import searchOpenTabsStyles from "./searchOpenTabs.css";

export async function openSearchOpenTabs(
  config: KeybindingsConfig,
): Promise<void> {
  try {
    const { host, shadow } = createPanelHost();

    // --- Keybind display strings ---
    const upKey = keyToDisplay(config.bindings.search.moveUp.key);
    const downKey = keyToDisplay(config.bindings.search.moveDown.key);
    const switchKey = keyToDisplay(config.bindings.search.switchPane.key);
    const acceptKey = keyToDisplay(config.bindings.search.accept.key);
    const closeKey = keyToDisplay(config.bindings.search.close.key);

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
        <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
      </div>
      <span class="ht-titlebar-text">Search Open Tabs</span>
      ${vimBadgeHtml(config)}`;
    panel.appendChild(titlebar);

    const titleText = titlebar.querySelector(".ht-titlebar-text") as HTMLElement;

    // Input row
    const inputWrap = document.createElement("div");
    inputWrap.className = "ht-open-tabs-input-wrap";
    inputWrap.innerHTML = `<span class="ht-open-tabs-prompt">&gt;</span>`;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ht-open-tabs-input";
    input.placeholder = "Filter tabs...";
    inputWrap.appendChild(input);
    panel.appendChild(inputWrap);

    // Results list
    const listEl = document.createElement("div");
    listEl.className = "ht-open-tabs-list";
    panel.appendChild(listEl);

    // Footer
    const footer = document.createElement("div");
    footer.className = "ht-footer";
    footer.innerHTML = `<div class="ht-footer-row">
      <span>j/k (vim) ${upKey}/${downKey} nav</span>
      <span>${switchKey} list</span>
      <span>${acceptKey} jump</span>
      <span>${closeKey} close</span>
    </div>`;
    panel.appendChild(footer);

    let allEntries: FrecencyEntry[] = [];
    let filtered: FrecencyEntry[] = [];
    let activeIndex = 0;
    let query = "";
    let activeItemEl: HTMLElement | null = null;

    function close(): void {
      document.removeEventListener("keydown", keyHandler, true);
      removePanelHost();
    }

    /** Highlight fuzzy query matches in text */
    function highlightMatch(text: string): string {
      const escaped = escapeHtml(text);
      if (!query) return escaped;
      const terms = query.trim().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return escaped;
      const pattern = terms
        .map((t) => `(${escapeRegex(escapeHtml(t))})`)
        .join("|");
      try {
        return escaped.replace(new RegExp(pattern, "gi"), "<mark>$1</mark>");
      } catch (_) {
        return escaped;
      }
    }

    let renderRafId = 0;
    let firstRender = true;

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
      activeItemEl = listEl.querySelector(".ht-open-tabs-item.active") as HTMLElement;
      if (activeItemEl) activeItemEl.scrollIntoView({ block: "nearest" });
    }

    /** Full rebuild of the results list (called when filtered data changes) */
    function renderList(): void {
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
        commitList(buildListFragment());
      });
    }

    /** Move active highlight without rebuilding DOM */
    function updateActiveHighlight(newIndex: number): void {
      if (newIndex === activeIndex && activeItemEl) return;
      // Remove old highlight
      if (activeItemEl) activeItemEl.classList.remove("active");
      activeIndex = newIndex;
      // Apply new highlight
      const items = listEl.querySelectorAll(".ht-open-tabs-item");
      activeItemEl = (items[activeIndex] as HTMLElement) || null;
      if (activeItemEl) {
        activeItemEl.classList.add("active");
        activeItemEl.scrollIntoView({ block: "nearest" });
      }
    }

    function onListClick(e: Event): void {
      const item = (e.target as HTMLElement).closest(".ht-open-tabs-item") as HTMLElement;
      if (!item) return;
      const idx = parseInt(item.dataset.index!);
      if (filtered[idx]) jumpToTab(filtered[idx]);
    }

    function applyFilter(): void {
      if (!query.trim()) {
        filtered = [...allEntries];
      } else {
        const re = buildFuzzyPattern(query);
        if (re) {
          filtered = allEntries.filter(
            (e) => re.test(e.title) || re.test(e.url),
          );
        } else {
          filtered = [...allEntries];
        }
      }
      activeIndex = Math.min(activeIndex, Math.max(filtered.length - 1, 0));
    }

    async function jumpToTab(entry: FrecencyEntry): Promise<void> {
      if (!entry) return;
      close();
      await browser.runtime.sendMessage({
        type: "SWITCH_TO_TAB",
        tabId: entry.tabId,
      });
    }

    function keyHandler(e: KeyboardEvent): void {
      if (!document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      if (matchesAction(e, config, "search", "close")) {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }

      if (matchesAction(e, config, "search", "accept")) {
        e.preventDefault();
        e.stopPropagation();
        if (filtered[activeIndex]) jumpToTab(filtered[activeIndex]);
        return;
      }

      // Tab cycles between input and results list (only if results exist)
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (filtered.length === 0) return;
        const shadowActive = host.shadowRoot?.activeElement;
        if (shadowActive === input) {
          if (activeItemEl) {
            activeItemEl.focus();
          } else {
            const first = listEl.querySelector(".ht-open-tabs-item") as HTMLElement;
            if (first) first.focus();
          }
          listEl.classList.add("focused");
        } else {
          input.focus();
          listEl.classList.remove("focused");
        }
        return;
      }

      const inputFocused = host.shadowRoot?.activeElement === input;

      if (matchesAction(e, config, "search", "moveDown")) {
        const lk = e.key.toLowerCase();
        if ((lk === "j" || lk === "k") && inputFocused) return;
        e.preventDefault();
        e.stopPropagation();
        if (filtered.length > 0) {
          updateActiveHighlight(Math.min(activeIndex + 1, filtered.length - 1));
          if (!inputFocused && activeItemEl) activeItemEl.focus();
        }
        return;
      }

      if (matchesAction(e, config, "search", "moveUp")) {
        const lk = e.key.toLowerCase();
        if ((lk === "j" || lk === "k") && inputFocused) return;
        e.preventDefault();
        e.stopPropagation();
        if (filtered.length > 0) {
          updateActiveHighlight(Math.max(activeIndex - 1, 0));
          if (!inputFocused && activeItemEl) activeItemEl.focus();
        }
        return;
      }

      // Block all other keys from reaching the page
      e.stopPropagation();
    }

    // Bind static events
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (e) => e.preventDefault());
    titlebar.querySelector(".ht-dot-close")!.addEventListener("click", close);
    listEl.addEventListener("click", onListClick);

    // Mouse wheel on results list: navigate items, block page scroll
    listEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length === 0) return;
      if (e.deltaY > 0) {
        updateActiveHighlight(Math.min(activeIndex + 1, filtered.length - 1));
      } else {
        updateActiveHighlight(Math.max(activeIndex - 1, 0));
      }
    });

    // Sync focused state on mouse clicks
    input.addEventListener("focus", () => { listEl.classList.remove("focused"); });
    listEl.addEventListener("focus", () => { listEl.classList.add("focused"); }, true);

    input.addEventListener("input", () => {
      query = input.value;
      applyFilter();
      renderList();
    });

    // Fetch frecency list and render
    allEntries = (await browser.runtime.sendMessage({
      type: "FRECENCY_LIST",
    })) as FrecencyEntry[];
    filtered = [...allEntries];

    document.addEventListener("keydown", keyHandler, true);
    registerPanelCleanup(close);
    renderList();
    input.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open search open tabs:", err);
  }
}
