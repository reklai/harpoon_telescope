// App init — wires up keybindings, message routing, and panel lifecycle.
// Imported by contentScript.ts as the single bootstrap for all content-side logic.

import browser from "webextension-polyfill";
import { matchesAction, saveKeybindings } from "../shared/keybindings";
import { grepPage, getPageContent } from "../searchCurrentPage/grep";
import { scrollToText } from "../shared/scroll";
import { showFeedback } from "../shared/feedback";
import { openTabManager } from "../tabManager/tabManager";
import { openSearchCurrentPage } from "../searchCurrentPage/searchCurrentPage";
import { openSearchOpenTabs } from "../searchOpenTabs/searchOpenTabs";
import { openBookmarkOverlay } from "../bookmarks/bookmarks";
import { openAddBookmarkOverlay } from "../addBookmark/addBookmark";
import { openHistoryOverlay } from "../history/history";
import { openHelpOverlay } from "../help/help";
import { dismissPanel } from "../shared/panelHost";
import { openSessionRestoreOverlay } from "../tabManager/session";

// Extend Window to track injection state
declare global {
  interface Window {
    __harpoonTelescopeCleanup?: () => void;
  }
}

export function initApp(): void {
  // Clean up previous injection when extension reloads
  if (window.__harpoonTelescopeCleanup) {
    window.__harpoonTelescopeCleanup();
  }

  // Cached keybinding config — loaded eagerly on startup so the keydown
  // handler never needs to await. Reloaded on storage changes.
  let cachedConfig: KeybindingsConfig | null = null;

  browser.runtime.sendMessage({ type: "GET_KEYBINDINGS" })
    .then((c) => { cachedConfig = c as KeybindingsConfig; })
    .catch(() => {});

  // Keep config for the message handler (async callers)
  async function getConfig(): Promise<KeybindingsConfig> {
    if (cachedConfig) return cachedConfig;
    cachedConfig = (await browser.runtime.sendMessage({
      type: "GET_KEYBINDINGS",
    })) as KeybindingsConfig;
    return cachedConfig;
  }

  browser.storage.onChanged.addListener((changes) => {
    if (changes.keybindings) {
      browser.runtime.sendMessage({ type: "GET_KEYBINDINGS" })
        .then((c) => { cachedConfig = c as KeybindingsConfig; })
        .catch(() => {});
    }
  });

  // Debounce panel-open actions to let cleanup settle between rapid presses.
  // Module-scoped so both globalKeyHandler and the message handler share it.
  let panelDebounce = 0;
  const PANEL_DEBOUNCE_MS = 50;

  /** Debounced panel opener — prevents rapid/concurrent opens from racing */
  function openPanel(fn: () => void): void {
    const now = Date.now();
    if (now - panelDebounce < PANEL_DEBOUNCE_MS) return;
    panelDebounce = now;
    try {
      fn();
    } catch (err) {
      console.error("[Harpoon Telescope] panel open failed:", err);
      showFeedback("Panel failed to open");
    }
  }

  // -- Global Keybinding Handler --
  // Runs on capture phase so pages that call stopPropagation() on keydown
  // can't break our keybinds. Fully synchronous — no microtask overhead.

  function globalKeyHandler(e: KeyboardEvent): void {
    if (!cachedConfig) return; // Config not loaded yet
    const config = cachedConfig;

    // toggleVim works regardless of whether a panel is open.
    // stopImmediatePropagation prevents overlay handlers from double-firing.
    if (matchesAction(e, config, "global", "toggleVim")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      config.navigationMode = config.navigationMode === "vim" ? "basic" : "vim";
      saveKeybindings(config); // fire-and-forget persistence
      showFeedback(config.navigationMode === "vim" ? "Vim motions ON" : "Vim motions OFF");
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

    // Block all actions when a panel is already open — user must close it first.
    if (document.getElementById("ht-panel-host")) return;

    if (matchesAction(e, config, "global", "openTabManager")) {
      e.preventDefault();
      e.stopPropagation();
      openPanel(() => openTabManager(config));
    } else if (matchesAction(e, config, "global", "addTab")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_ADD" });
    } else if (matchesAction(e, config, "global", "jumpSlot1")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_JUMP", slot: 1 });
    } else if (matchesAction(e, config, "global", "jumpSlot2")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_JUMP", slot: 2 });
    } else if (matchesAction(e, config, "global", "jumpSlot3")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_JUMP", slot: 3 });
    } else if (matchesAction(e, config, "global", "jumpSlot4")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_JUMP", slot: 4 });
    } else if (matchesAction(e, config, "global", "cyclePrev")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_CYCLE", direction: "prev" });
    } else if (matchesAction(e, config, "global", "cycleNext")) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_CYCLE", direction: "next" });
    } else if (matchesAction(e, config, "global", "searchInPage")) {
      e.preventDefault();
      e.stopPropagation();
      openPanel(() => openSearchCurrentPage(config));
    } else if (matchesAction(e, config, "global", "openFrecency")) {
      e.preventDefault();
      e.stopPropagation();
      openPanel(() => openSearchOpenTabs(config));
    } else if (matchesAction(e, config, "global", "openBookmarks")) {
      e.preventDefault();
      e.stopPropagation();
      openPanel(() => openBookmarkOverlay(config));
    } else if (matchesAction(e, config, "global", "addBookmark")) {
      e.preventDefault();
      e.stopPropagation();
      openPanel(() => openAddBookmarkOverlay(config));
    } else if (matchesAction(e, config, "global", "openHistory")) {
      e.preventDefault();
      e.stopPropagation();
      openPanel(() => openHistoryOverlay(config));
    } else if (matchesAction(e, config, "global", "openHelp")) {
      e.preventDefault();
      e.stopPropagation();
      openPanel(() => openHelpOverlay(config));
    }
  }

  document.addEventListener("keydown", globalKeyHandler, true);

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
      case "OPEN_SEARCH_CURRENT_PAGE":
        if (!document.getElementById("ht-panel-host"))
          getConfig().then((config) => openPanel(() => openSearchCurrentPage(config)))
            .catch(() => showFeedback("Panel failed to open"));
        return Promise.resolve({ ok: true });
      case "OPEN_TAB_MANAGER":
        if (!document.getElementById("ht-panel-host"))
          getConfig().then((config) => openPanel(() => openTabManager(config)))
            .catch(() => showFeedback("Panel failed to open"));
        return Promise.resolve({ ok: true });
      case "OPEN_FRECENCY":
        if (!document.getElementById("ht-panel-host"))
          getConfig().then((config) => openPanel(() => openSearchOpenTabs(config)))
            .catch(() => showFeedback("Panel failed to open"));
        return Promise.resolve({ ok: true });
      case "OPEN_BOOKMARKS":
        if (!document.getElementById("ht-panel-host"))
          getConfig().then((config) => openPanel(() => openBookmarkOverlay(config)))
            .catch(() => showFeedback("Panel failed to open"));
        return Promise.resolve({ ok: true });
      case "OPEN_HISTORY":
        if (!document.getElementById("ht-panel-host"))
          getConfig().then((config) => openPanel(() => openHistoryOverlay(config)))
            .catch(() => showFeedback("Panel failed to open"));
        return Promise.resolve({ ok: true });
      case "SHOW_SESSION_RESTORE":
        if (!document.getElementById("ht-panel-host"))
          openSessionRestoreOverlay();
        return Promise.resolve({ ok: true });
      case "SCROLL_TO_TEXT":
        scrollToText(m.text as string);
        return Promise.resolve({ ok: true });
      case "TAB_MANAGER_ADDED_FEEDBACK":
        showFeedback(
          m.alreadyAdded
            ? `Already in Tab Manager [${m.slot}]`
            : `Added to Tab Manager [${m.slot}]`,
        );
        return Promise.resolve({ ok: true });
      case "TAB_MANAGER_FULL_FEEDBACK":
        showFeedback(`Tab Manager is full (${m.max}/${m.max})`);
        return Promise.resolve({ ok: true });
    }
  }

  browser.runtime.onMessage.addListener(messageHandler);

  // Signal background that this content script is ready to receive messages
  // (used for deferred scroll restoration on re-opened tabs)
  browser.runtime.sendMessage({ type: "CONTENT_SCRIPT_READY" }).catch(() => {});

  // Auto-close panels when switching tabs/windows
  function visibilityHandler(): void {
    if (document.visibilityState === "hidden") {
      dismissPanel();
    }
  }

  document.addEventListener("visibilitychange", visibilityHandler);

  // Allow next injection to clean up this one
  window.__harpoonTelescopeCleanup = () => {
    document.removeEventListener("keydown", globalKeyHandler, true);
    document.removeEventListener("visibilitychange", visibilityHandler);
    browser.runtime.onMessage.removeListener(messageHandler);
    const host = document.getElementById("ht-panel-host");
    if (host) host.remove();
    const toast = document.getElementById("ht-feedback-toast");
    if (toast) toast.remove();
  };
}
