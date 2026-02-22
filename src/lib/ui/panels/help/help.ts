// Help overlay — read-only scrollable reference for all keybindings and features.
// Alt+M to open, scroll with wheel / j/k / arrows, Esc to close.

import { keyToDisplay } from "../../../shared/keybindings";
import { matchesAction } from "../../../shared/keybindings";
import { escapeHtml } from "../../../shared/helpers";
import {
  createPanelHost,
  removePanelHost,
  registerPanelCleanup,
  getBaseStyles,
  footerRowHtml,
  vimBadgeHtml,
  dismissPanel,
} from "../../shared/panelHost";
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
  const p = config.bindings.session;
  const k = (b: KeyBinding) => keyToDisplay(b.key);
  const searchPaneHint = `${k(s.switchPane)} list / ${k(s.focusSearch)} search`;

  return [
    {
      title: "Open Panels",
      items: [
        { label: "Search Current Page", key: k(g.searchInPage) },
        { label: "Search Open Tabs", key: k(g.openFrecency) },
        { label: "Tab Manager", key: k(g.openTabManager) },
        { label: "Sessions", key: k(g.openSessions) },
        { label: "Save Session", key: k(g.openSessionSave) },
        { label: "Help (this menu)", key: k(g.openHelp) },
      ],
    },
    {
      title: "Navigation Mode",
      items: [
        { label: "Standard mode", key: "always on" },
        { label: "Adds j / k for up / down", key: "in all panels" },
      ],
    },
    {
      title: "Inside Any Panel",
      items: [
        { label: "Navigate up / down", key: `${k(s.moveUp)} / ${k(s.moveDown)}` },
        { label: "Built-in alias (always on)", key: "j / k" },
        { label: "Half-page jump (list-focused)", key: "Ctrl+D / Ctrl+U" },
        { label: "Search panels: focus list/search", key: searchPaneHint },
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
        { label: "Swap mode", key: k(h.swap) },
        { label: "Del entry", key: k(h.remove) },
        { label: "Undo remove", key: k(h.undo) },
      ],
    },
    {
      title: "Session Menu",
      items: [
        { label: "Open session menu", key: k(g.openSessions) },
        { label: "Main view", key: "Load sessions list" },
        { label: "Open save session", key: k(g.openSessionSave) },
        { label: "Load selected session", key: k(h.jump) },
        { label: "Save mode preview", key: "current tab-manager tabs" },
        { label: "Session list focus list", key: k(p.focusList) },
        { label: "Session search focus", key: k(p.focusSearch) },
        { label: "Session clear-search", key: k(p.clearSearch) },
        { label: "Session list half-page jump", key: "Ctrl+D / Ctrl+U" },
        { label: "Delete session (in session list)", key: k(h.remove) },
        { label: "Load plan symbols", key: "NEW (+) · DELETED (-) · REPLACED (~) · UNCHANGED (=)" },
        { label: "Session load confirm / cancel", key: `${k(p.confirmYes)} / ${k(p.confirmNo)}` },
        { label: "Rename session (in session list)", key: k(p.rename) },
        { label: "Overwrite session (in session list)", key: k(p.overwrite) },
      ],
    },
    {
      title: "Search Current Page",
      items: [
        { label: "Focus list/search", key: searchPaneHint },
        { label: "Clear-search", key: k(s.clearSearch) },
      ],
    },
    {
      title: "Search Open Tabs",
      items: [
        { label: "Focus list/search", key: searchPaneHint },
        { label: "Clear-search", key: k(s.clearSearch) },
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
      ],
    },
  ];
}

export function openHelpOverlay(config: KeybindingsConfig): void {
  try {
    const { host, shadow } = createPanelHost();

    const closeKey = keyToDisplay(config.bindings.search.close.key);
    const moveUpKey = keyToDisplay(config.bindings.search.moveUp.key);
    const moveDownKey = keyToDisplay(config.bindings.search.moveDown.key);

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
        <button class="ht-dot ht-dot-close" title="Close (${escapeHtml(closeKey)})"></button>
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
    function renderFooter(): void {
      const scrollHints = config.navigationMode === "standard"
        ? [
          { key: "j/k", desc: "scroll" },
          { key: `${moveUpKey}/${moveDownKey}`, desc: "scroll" },
        ]
        : [
          { key: `${moveUpKey}/${moveDownKey}`, desc: "scroll" },
        ];
      footer.innerHTML = `${footerRowHtml(scrollHints)}
      ${footerRowHtml([
        { key: "Wheel", desc: "scroll" },
        { key: closeKey, desc: "close" },
      ])}`;
    }

    function onNavigationModeChanged(): void {
      renderFooter();
    }

    renderFooter();
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
      window.removeEventListener("ht-navigation-mode-changed", onNavigationModeChanged);
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

      // Arrow keys or j/k aliases scroll the body
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
    window.addEventListener("ht-navigation-mode-changed", onNavigationModeChanged);
    registerPanelCleanup(close);
    host.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open help overlay:", err);
    dismissPanel();
  }
}
