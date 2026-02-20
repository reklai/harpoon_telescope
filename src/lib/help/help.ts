// Help overlay — read-only scrollable reference for all keybindings and features.
// Alt+M to open, scroll with wheel / j/k / arrows, Esc to close.

import { keyToDisplay } from "../shared/keybindings";
import { matchesAction } from "../shared/keybindings";
import { createPanelHost, removePanelHost, registerPanelCleanup, getBaseStyles, vimBadgeHtml } from "../shared/panelHost";
import styles from "./help.css";

/** Section definition for the help content */
interface HelpSection {
  title: string;
  items: { label: string; key: string }[];
}

// Scroll step in pixels for keyboard navigation
const SCROLL_STEP = 80;

/** Build help sections from the live keybinding config */
function buildSections(config: KeybindingsConfig): HelpSection[] {
  const g = config.bindings.global;
  const h = config.bindings.tabManager;
  const s = config.bindings.search;
  const k = (b: KeyBinding) => keyToDisplay(b.key);

  return [
    {
      title: "Open Panels",
      items: [
        { label: "Search Current Page", key: k(g.searchInPage) },
        { label: "Search Open Tabs", key: k(g.openFrecency) },
        { label: "Tab Manager", key: k(g.openTabManager) },
        { label: "Bookmarks", key: k(g.openBookmarks) },
        { label: "History", key: k(g.openHistory) },
        { label: "Help (this menu)", key: k(g.openHelp) },
      ],
    },
    {
      title: "Vim Mode (optional)",
      items: [
        { label: "Toggle vim mode", key: k(g.toggleVim) },
        { label: "Adds j / k for up / down", key: "in all panels" },
      ],
    },
    {
      title: "Inside Any Panel",
      items: [
        { label: "Navigate up / down", key: `${k(s.moveUp)} / ${k(s.moveDown)}` },
        { label: "Switch input and results", key: k(s.switchPane) },
        { label: "Open / jump to selection", key: k(s.accept) },
        { label: "Close panel", key: k(s.close) },
        { label: "Click item to select or open", key: "mouse" },
        { label: "Scroll wheel to navigate", key: "mouse" },
      ],
    },
    {
      title: "Tab Manager Panel",
      items: [
        { label: "Add current tab to Tab Manager", key: k(g.addTab) },
        { label: "Jump to slot 1 — 4", key: `${k(g.jumpSlot1)} — ${k(g.jumpSlot4)}` },
        { label: "Cycle prev / next slot", key: `${k(g.cyclePrev)} / ${k(g.cycleNext)}` },
        { label: "Swap mode", key: k(h.swap).toLowerCase() },
        { label: "Del entry", key: k(h.remove).toLowerCase() },
        { label: "Undo remove", key: "u" },
        { label: "Save session", key: k(h.saveSession).toLowerCase() },
        { label: "Load session", key: k(h.loadSession).toLowerCase() },
        { label: "Rename session (in session list)", key: "r" },
        { label: "Overwrite session (in session list)", key: "o" },
      ],
    },
    {
      title: "Bookmarks Panel",
      items: [
        { label: "Add bookmark", key: k(g.addBookmark) },
        { label: "Focus tree", key: "t" },
        { label: "Clear search", key: "c" },
        { label: "Del bookmark", key: "d" },
        { label: "Move to folder", key: "m" },
      ],
    },
    {
      title: "History Panel",
      items: [
        { label: "Focus tree", key: "t" },
        { label: "Clear search", key: "c" },
        { label: "Del entry", key: "d" },
      ],
    },
    {
      title: "Search Current Page",
      items: [
        { label: "Clear search", key: "c" },
      ],
    },
    {
      title: "Search Open Tabs",
      items: [
        { label: "Clear search", key: "c" },
      ],
    },
    {
      title: "Search Filters — type in search input",
      items: [
        { label: "Code blocks (<pre>, <code>)", key: "/code" },
        { label: "Headings (<h1>-<h6>)", key: "/headings" },
        { label: "Images (<img> alt text)", key: "/img" },
        { label: "Links (<a> elements)", key: "/links" },
        { label: "Combine filters (union)", key: "/code /links" },
        { label: "Bookmark: folder path", key: "/folder" },
        { label: "History: last hour", key: "/hour" },
        { label: "History: today", key: "/today" },
        { label: "History: last 7 days", key: "/week" },
        { label: "History: last 30 days", key: "/month" },
      ],
    },
  ];
}

export function openHelpOverlay(config: KeybindingsConfig): void {
  try {
    const { host, shadow } = createPanelHost();

    const closeKey = keyToDisplay(config.bindings.search.close.key);

    const style = document.createElement("style");
    style.textContent = getBaseStyles() + styles;
    shadow.appendChild(style);

    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "ht-backdrop";
    shadow.appendChild(backdrop);

    // Panel container
    const panel = document.createElement("div");
    panel.className = "ht-help-container";
    shadow.appendChild(panel);

    // Titlebar
    const titlebar = document.createElement("div");
    titlebar.className = "ht-titlebar";
    titlebar.innerHTML = `
      <div class="ht-traffic-lights">
        <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
      </div>
      <span class="ht-help-titlebar-text">
        <span class="ht-help-title-label">Help</span>
      </span>
      ${vimBadgeHtml(config)}`;
    panel.appendChild(titlebar);

    // Body (scrollable)
    const body = document.createElement("div");
    body.className = "ht-help-body";
    panel.appendChild(body);

    // Footer
    const footer = document.createElement("div");
    footer.className = "ht-footer";
    footer.innerHTML = `<div class="ht-footer-row">
      <span>j/k (vim) ↑/↓ scroll</span>
      <span>wheel scroll</span>
      <span>${closeKey} close</span>
    </div>`;
    panel.appendChild(footer);

    // --- Render sections ---
    const sections = buildSections(config);

    for (const section of sections) {
      const sectionEl = document.createElement("div");
      sectionEl.className = "ht-help-section";

      const header = document.createElement("div");
      header.className = "ht-help-header";

      const titleSpan = document.createElement("span");
      titleSpan.textContent = section.title;
      header.appendChild(titleSpan);
      sectionEl.appendChild(header);

      const itemsEl = document.createElement("div");
      itemsEl.className = "ht-help-items";

      for (const item of section.items) {
        const row = document.createElement("div");
        row.className = "ht-help-row";

        const label = document.createElement("span");
        label.className = "ht-help-label";
        label.textContent = item.label;

        const key = document.createElement("span");
        key.className = "ht-help-key";
        key.textContent = item.key;

        row.appendChild(label);
        row.appendChild(key);
        itemsEl.appendChild(row);
      }

      sectionEl.appendChild(itemsEl);
      body.appendChild(sectionEl);
    }

    // Tip at bottom
    const tip = document.createElement("div");
    tip.className = "ht-help-tip";
    tip.innerHTML = "Keybindings Can Be <strong>Customized</strong> In The <strong>Extension Options Page</strong>";
    body.appendChild(tip);

    // --- Event handlers ---

    function close(): void {
      document.removeEventListener("keydown", keyHandler, true);
      removePanelHost();
    }

    function keyHandler(event: KeyboardEvent): void {
      if (!document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      if (matchesAction(event, config, "search", "close")) {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }

      // Arrow keys or j/k (vim mode) scroll the body
      const isDown = matchesAction(event, config, "search", "moveDown");
      const isUp = matchesAction(event, config, "search", "moveUp");

      if (isDown) {
        event.preventDefault();
        event.stopPropagation();
        body.scrollTop += SCROLL_STEP;
        return;
      }

      if (isUp) {
        event.preventDefault();
        event.stopPropagation();
        body.scrollTop -= SCROLL_STEP;
        return;
      }

      // Block all other keys from reaching the page
      event.stopPropagation();
    }

    // Bind events
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (event) => event.preventDefault());
    titlebar.querySelector(".ht-dot-close")!.addEventListener("click", close);
    document.addEventListener("keydown", keyHandler, true);
    registerPanelCleanup(close);
    host.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open help overlay:", err);
  }
}
