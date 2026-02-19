// Frecency overlay — frecency-sorted list of all open tabs with fuzzy filter.
// Alt+Y to open, type to filter, Tab to cycle input/results, Enter to jump.

import browser from "webextension-polyfill";
import { matchesAction, keyToDisplay, saveKeybindings } from "./keybindings";
import { createPanelHost, removePanelHost, getBaseStyles, vimBadgeHtml } from "./panel-host";
import { escapeHtml, escapeRegex, extractDomain } from "./helpers";
import { showFeedback } from "./feedback";

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

export async function openFrecencyOverlay(
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
    style.textContent =
      getBaseStyles() +
      `
      .ht-frecency-container {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 480px; max-width: 90vw; max-height: 520px; background: #1e1e1e;
        border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
      }
      .ht-frecency-input-wrap {
        display: flex; align-items: center; padding: 8px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06); background: #252525;
      }
      .ht-frecency-prompt { color: #0a84ff; margin-right: 8px; font-weight: 600; font-size: 14px; }
      .ht-frecency-input {
        flex: 1; background: transparent; border: none; outline: none;
        color: #e0e0e0; font-family: inherit; font-size: 13px;
        caret-color: #ffffff; caret-shape: block;
      }
      .ht-frecency-input::placeholder { color: #666; }
      .ht-frecency-list { max-height: 380px; overflow-y: auto; }
      .ht-frecency-item {
        display: flex; align-items: center; padding: 8px 14px; gap: 10px;
        cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.04);
        user-select: none; outline: none;
      }
      .ht-frecency-item:hover { background: rgba(255,255,255,0.06); }
      .ht-frecency-item.active {
        background: rgba(10,132,255,0.15); border-left: 2px solid #0a84ff;
      }
      .ht-frecency-list.focused .ht-frecency-item.active {
        background: rgba(255,255,255,0.13); border-left: 2px solid #fff;
      }
      .ht-frecency-score {
        font-size: 10px; color: #808080; min-width: 36px; text-align: right;
        flex-shrink: 0;
      }
      .ht-frecency-info { flex: 1; overflow: hidden; }
      .ht-frecency-title {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-size: 12px; color: #e0e0e0;
      }
      .ht-frecency-title mark {
        background: #f9d45c; color: #1e1e1e; border-radius: 2px; padding: 0 1px;
      }
      .ht-frecency-url {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-size: 10px; color: #808080; margin-top: 2px;
      }
      .ht-frecency-empty {
        padding: 24px; text-align: center; color: #808080; font-size: 12px;
      }
    `;
    shadow.appendChild(style);

    // --- Build static shell (only once) ---
    const backdrop = document.createElement("div");
    backdrop.className = "ht-backdrop";
    shadow.appendChild(backdrop);

    const panel = document.createElement("div");
    panel.className = "ht-frecency-container";
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
    inputWrap.className = "ht-frecency-input-wrap";
    inputWrap.innerHTML = `<span class="ht-frecency-prompt">&gt;</span>`;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ht-frecency-input";
    input.placeholder = "Filter tabs...";
    inputWrap.appendChild(input);
    panel.appendChild(inputWrap);

    // Results list
    const listEl = document.createElement("div");
    listEl.className = "ht-frecency-list";
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
        item.className = i === activeIndex ? "ht-frecency-item active" : "ht-frecency-item";
        item.dataset.index = String(i);
        item.dataset.tabId = String(entry.tabId);
        item.tabIndex = -1;

        const score = document.createElement("span");
        score.className = "ht-frecency-score";
        score.textContent = String(entry.frecencyScore);

        const info = document.createElement("div");
        info.className = "ht-frecency-info";

        const title = document.createElement("div");
        title.className = "ht-frecency-title";
        title.innerHTML = highlightMatch(entry.title || "Untitled");

        const url = document.createElement("div");
        url.className = "ht-frecency-url";
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
      activeItemEl = listEl.querySelector(".ht-frecency-item.active") as HTMLElement;
      if (activeItemEl) activeItemEl.scrollIntoView({ block: "nearest" });
    }

    /** Full rebuild of the results list (called when filtered data changes) */
    function renderList(): void {
      titleText.textContent = query
        ? `Search Open Tabs (${filtered.length})`
        : "Search Open Tabs";

      if (filtered.length === 0) {
        cancelAnimationFrame(renderRafId);
        listEl.innerHTML = `<div class="ht-frecency-empty">${
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
      const items = listEl.querySelectorAll(".ht-frecency-item");
      activeItemEl = (items[activeIndex] as HTMLElement) || null;
      if (activeItemEl) {
        activeItemEl.classList.add("active");
        activeItemEl.scrollIntoView({ block: "nearest" });
      }
    }

    function onListClick(e: Event): void {
      const item = (e.target as HTMLElement).closest(".ht-frecency-item") as HTMLElement;
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
            const first = listEl.querySelector(".ht-frecency-item") as HTMLElement;
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
    renderList();
    input.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open frecency overlay:", err);
  }
}
