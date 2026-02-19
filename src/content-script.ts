// Content script entry point — runs on every page.
// Routes messages from the background script to the appropriate handler,
// manages config caching, and handles global keybindings that can't go
// through browser.commands (e.g. Chrome's 4-command limit).

import browser from "webextension-polyfill";
import { matchesAction, saveKeybindings } from "./lib/keybindings";
import { grepPage, getPageContent } from "./lib/grep";
import { scrollToText } from "./lib/scroll";
import { showFeedback } from "./lib/feedback";
import { openHarpoonOverlay } from "./lib/harpoon-overlay";
import { openTelescope } from "./lib/search-overlay";
import { openFrecencyOverlay } from "./lib/frecency-overlay";
import { openBookmarkOverlay, openAddBookmarkOverlay } from "./lib/bookmark-overlay";
import { openHistoryOverlay } from "./lib/history-overlay";
import { openSessionRestoreOverlay } from "./lib/session-views";

// Extend Window to track injection state
declare global {
  interface Window {
    __harpoonTelescopeCleanup?: () => void;
  }
}

(() => {
  // Clean up previous injection when extension reloads
  if (window.__harpoonTelescopeCleanup) {
    window.__harpoonTelescopeCleanup();
  }

  // Cached keybinding config — invalidated on storage changes
  let cachedConfig: KeybindingsConfig | null = null;

  async function getConfig(): Promise<KeybindingsConfig> {
    if (!cachedConfig) {
      cachedConfig = (await browser.runtime.sendMessage({
        type: "GET_KEYBINDINGS",
      })) as KeybindingsConfig;
    }
    return cachedConfig;
  }

  browser.storage.onChanged.addListener((changes) => {
    if (changes.keybindings) cachedConfig = null;
  });

  // -- Global Keybinding Handler --
  // Catches shortcuts that browser.commands doesn't handle (Chrome limits
  // commands to 4, so Alt+1-4 slot jumps go through here). On Firefox with
  // all 8 commands registered, browser.commands intercepts the key event
  // before it reaches the page, so this won't double-fire.
  async function globalKeyHandler(e: KeyboardEvent): Promise<void> {
    const config = await getConfig();

    // toggleVim must work regardless of whether a panel is open
    if (matchesAction(e, config, "global", "toggleVim")) {
      e.preventDefault();
      e.stopPropagation();
      config.navigationMode = config.navigationMode === "vim" ? "basic" : "vim";
      cachedConfig = config;
      await saveKeybindings(config);
      showFeedback(config.navigationMode === "vim" ? "Vim motions ON" : "Vim motions OFF");
      // If a panel is open, update the vim badge live
      const panelHost = document.getElementById("ht-panel-host");
      if (panelHost?.shadowRoot) {
        const badge = panelHost.shadowRoot.querySelector(".ht-vim-badge");
        if (badge) {
          badge.classList.toggle("on", config.navigationMode === "vim");
          badge.classList.toggle("off", config.navigationMode !== "vim");
        }
      }
      return;
    }

    // Skip remaining global shortcuts if a panel overlay is already open
    // (the panel has its own key handler)
    if (document.getElementById("ht-panel-host")) return;

    if (matchesAction(e, config, "global", "openHarpoon")) {
      e.preventDefault();
      e.stopPropagation();
      openHarpoonOverlay(config);
    } else if (matchesAction(e, config, "global", "addTab")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "HARPOON_ADD" });
    } else if (matchesAction(e, config, "global", "jumpSlot1")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "HARPOON_JUMP", slot: 1 });
    } else if (matchesAction(e, config, "global", "jumpSlot2")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "HARPOON_JUMP", slot: 2 });
    } else if (matchesAction(e, config, "global", "jumpSlot3")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "HARPOON_JUMP", slot: 3 });
    } else if (matchesAction(e, config, "global", "jumpSlot4")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "HARPOON_JUMP", slot: 4 });
    } else if (matchesAction(e, config, "global", "cyclePrev")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "HARPOON_CYCLE", direction: "prev" });
    } else if (matchesAction(e, config, "global", "cycleNext")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "HARPOON_CYCLE", direction: "next" });
    } else if (matchesAction(e, config, "global", "searchInPage")) {
      e.preventDefault();
      e.stopPropagation();
      openTelescope(config);
    } else if (matchesAction(e, config, "global", "openFrecency")) {
      e.preventDefault();
      e.stopPropagation();
      openFrecencyOverlay(config);
    } else if (matchesAction(e, config, "global", "openBookmarks")) {
      e.preventDefault();
      e.stopPropagation();
      openBookmarkOverlay(config);
    } else if (matchesAction(e, config, "global", "addBookmark")) {
      e.preventDefault();
      e.stopPropagation();
      openAddBookmarkOverlay(config);
    } else if (matchesAction(e, config, "global", "openHistory")) {
      e.preventDefault();
      e.stopPropagation();
      openHistoryOverlay(config);
    }
  }

  document.addEventListener("keydown", globalKeyHandler);

  // -- Message Router --
  function messageHandler(msg: unknown): Promise<unknown> | undefined {
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case "GET_SCROLL":
        return Promise.resolve({
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        });
      case "SET_SCROLL":
        window.scrollTo(m.scrollX as number, m.scrollY as number);
        return Promise.resolve({ ok: true });
      case "GREP":
        return Promise.resolve(grepPage(m.query as string, (m.filters as SearchFilter[]) || []));
      case "GET_CONTENT":
        return Promise.resolve(getPageContent());
      case "OPEN_TELESCOPE":
        getConfig().then((config) => openTelescope(config));
        return Promise.resolve({ ok: true });
      case "OPEN_HARPOON_OVERLAY":
        getConfig().then((config) => openHarpoonOverlay(config));
        return Promise.resolve({ ok: true });
      case "OPEN_FRECENCY":
        getConfig().then((config) => openFrecencyOverlay(config));
        return Promise.resolve({ ok: true });
      case "OPEN_BOOKMARKS":
        getConfig().then((config) => openBookmarkOverlay(config));
        return Promise.resolve({ ok: true });
      case "OPEN_HISTORY":
        getConfig().then((config) => openHistoryOverlay(config));
        return Promise.resolve({ ok: true });
      case "SHOW_SESSION_RESTORE":
        openSessionRestoreOverlay();
        return Promise.resolve({ ok: true });
      case "SCROLL_TO_TEXT":
        scrollToText(m.text as string);
        return Promise.resolve({ ok: true });
      case "HARPOON_ADDED_FEEDBACK":
        showFeedback(
          m.alreadyAdded
            ? `Already in Harpoon [${m.slot}]`
            : `Added to Harpoon [${m.slot}]`,
        );
        return Promise.resolve({ ok: true });
      case "HARPOON_FULL_FEEDBACK":
        showFeedback(`Harpoon is full (${m.max}/${m.max})`);
        return Promise.resolve({ ok: true });
    }
  }

  browser.runtime.onMessage.addListener(messageHandler);

  // Auto-close panels when switching tabs/windows
  function visibilityHandler(): void {
    if (document.visibilityState === "hidden") {
      const host = document.getElementById("ht-panel-host");
      if (host) host.remove();
    }
  }

  document.addEventListener("visibilitychange", visibilityHandler);

  // Allow next injection to clean up this one
  window.__harpoonTelescopeCleanup = () => {
    document.removeEventListener("keydown", globalKeyHandler);
    document.removeEventListener("visibilitychange", visibilityHandler);
    browser.runtime.onMessage.removeListener(messageHandler);
    const host = document.getElementById("ht-panel-host");
    if (host) host.remove();
    const toast = document.getElementById("ht-feedback-toast");
    if (toast) toast.remove();
  };
})();
