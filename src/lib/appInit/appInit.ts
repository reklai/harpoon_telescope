// App init — wires up keybindings, message routing, and panel lifecycle.
// Imported by contentScript.ts as the single bootstrap for all content-side logic.

import browser from "webextension-polyfill";
import { DEFAULT_KEYBINDINGS, matchesAction } from "../shared/keybindings";
import { grepPage, getPageContent } from "../searchCurrentPage/grep";
import { scrollToText } from "../shared/scroll";
import { showFeedback } from "../shared/feedback";
import { openTabManager } from "../tabManager/tabManager";
import { openSearchCurrentPage } from "../searchCurrentPage/searchCurrentPage";
import { openSearchOpenTabs } from "../searchOpenTabs/searchOpenTabs";
import { openBookmarkOverlay } from "../bookmarks/bookmarks";
import { openAddBookmarkOverlay } from "../addBookmark/addBookmark";
import { openHelpOverlay } from "../help/help";
import { dismissPanel } from "../shared/panelHost";
import { ContentRuntimeMessage } from "../shared/runtimeMessages";
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
  let configLoadPromise: Promise<KeybindingsConfig> | null = null;

  function requestConfigLoad(): Promise<KeybindingsConfig> {
    if (cachedConfig) return Promise.resolve(cachedConfig);
    if (configLoadPromise) return configLoadPromise;

    configLoadPromise = browser.runtime.sendMessage({ type: "GET_KEYBINDINGS" })
      .then((loadedConfig) => {
        cachedConfig = loadedConfig as KeybindingsConfig;
        cachedConfig.navigationMode = "vim";
        return cachedConfig;
      })
      .finally(() => {
        configLoadPromise = null;
      });

    return configLoadPromise;
  }

  requestConfigLoad().catch(() => {});

  // Keep config for the message handler (async callers)
  async function getConfig(): Promise<KeybindingsConfig> {
    if (cachedConfig) return cachedConfig;
    return requestConfigLoad();
  }

  browser.storage.onChanged.addListener((changes) => {
    if (changes.keybindings) {
      const nextConfig = changes.keybindings.newValue as KeybindingsConfig | undefined;
      if (nextConfig && typeof nextConfig === "object") {
        nextConfig.navigationMode = "vim";
        cachedConfig = nextConfig;
      } else {
        cachedConfig = null;
        requestConfigLoad().catch(() => {});
      }
    }
  });

  // Debounce panel-open actions to let cleanup settle between rapid presses.
  // Module-scoped so both globalKeyHandler and the message handler share it.
  let panelDebounce = 0;
  const PANEL_DEBOUNCE_MS = 50;

  /** Debounced panel opener — prevents rapid/concurrent opens from racing */
  function openPanel(fn: () => void | Promise<void>): void {
    const now = Date.now();
    if (now - panelDebounce < PANEL_DEBOUNCE_MS) return;
    panelDebounce = now;
    try {
      const maybePromise = fn();
      if (maybePromise && typeof (maybePromise as Promise<void>).then === "function") {
        void (maybePromise as Promise<void>).catch((err) => {
          console.error("[Harpoon Telescope] panel open failed:", err);
          dismissPanel();
          showFeedback("Panel failed to open");
        });
      }
    } catch (err) {
      console.error("[Harpoon Telescope] panel open failed:", err);
      dismissPanel();
      showFeedback("Panel failed to open");
    }
  }

  // Defensive host integrity check:
  // if a prior panel open crashed before rendering, clear the stale host so
  // the next shortcut can proceed instead of getting blocked forever.
  function hasLivePanelHost(): boolean {
    const host = document.getElementById("ht-panel-host");
    if (!host) return false;
    const shadow = host.shadowRoot;
    if (!shadow || shadow.childElementCount === 0) {
      dismissPanel();
      return false;
    }
    return true;
  }

  // -- Global Keybinding Handler --
  // Runs on capture phase so pages that call stopPropagation() on keydown
  // can't break our keybinds. Fully synchronous — no microtask overhead.

  function tryHandleGlobalActions(event: KeyboardEvent, config: KeybindingsConfig): boolean {
    // Block all actions when a panel is already open — user must close it first.
    if (hasLivePanelHost()) return false;

    if (matchesAction(event, config, "global", "openTabManager")) {
      event.preventDefault();
      event.stopPropagation();
      openPanel(() => openTabManager(config));
      return true;
    }
    if (matchesAction(event, config, "global", "addTab")) {
      event.preventDefault();
      event.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_ADD" });
      return true;
    }
    if (matchesAction(event, config, "global", "jumpSlot1")) {
      event.preventDefault();
      event.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_JUMP", slot: 1 });
      return true;
    }
    if (matchesAction(event, config, "global", "jumpSlot2")) {
      event.preventDefault();
      event.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_JUMP", slot: 2 });
      return true;
    }
    if (matchesAction(event, config, "global", "jumpSlot3")) {
      event.preventDefault();
      event.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_JUMP", slot: 3 });
      return true;
    }
    if (matchesAction(event, config, "global", "jumpSlot4")) {
      event.preventDefault();
      event.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_JUMP", slot: 4 });
      return true;
    }
    if (matchesAction(event, config, "global", "cyclePrev")) {
      event.preventDefault();
      event.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_CYCLE", direction: "prev" });
      return true;
    }
    if (matchesAction(event, config, "global", "cycleNext")) {
      event.preventDefault();
      event.stopPropagation();
      browser.runtime.sendMessage({ type: "TAB_MANAGER_CYCLE", direction: "next" });
      return true;
    }
    if (matchesAction(event, config, "global", "searchInPage")) {
      event.preventDefault();
      event.stopPropagation();
      openPanel(() => openSearchCurrentPage(config));
      return true;
    }
    if (matchesAction(event, config, "global", "openFrecency")) {
      event.preventDefault();
      event.stopPropagation();
      openPanel(() => openSearchOpenTabs(config));
      return true;
    }
    if (matchesAction(event, config, "global", "openBookmarks")) {
      event.preventDefault();
      event.stopPropagation();
      openPanel(() => openBookmarkOverlay(config));
      return true;
    }
    if (matchesAction(event, config, "global", "addBookmark")) {
      event.preventDefault();
      event.stopPropagation();
      openPanel(() => openAddBookmarkOverlay(config));
      return true;
    }
    if (matchesAction(event, config, "global", "openHelp")) {
      event.preventDefault();
      event.stopPropagation();
      openPanel(() => openHelpOverlay(config));
      return true;
    }
    return false;
  }

  function globalKeyHandler(event: KeyboardEvent): void {
    if (!cachedConfig) {
      // Retry in-case initial keybinding fetch failed during tab startup.
      requestConfigLoad().catch(() => {});
      // Fallback to defaults so first keypress on a fresh tab still works.
      if (tryHandleGlobalActions(event, DEFAULT_KEYBINDINGS)) return;
      return;
    }
    const config = cachedConfig;

    void tryHandleGlobalActions(event, config);
  }

  document.addEventListener("keydown", globalKeyHandler, true);

  // -- Message Router --
  function messageHandler(message: unknown): Promise<unknown> | undefined {
    const receivedMessage = message as ContentRuntimeMessage;
    switch (receivedMessage.type) {
      case "GET_SCROLL":
        return Promise.resolve({
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        });
      case "SET_SCROLL":
        window.scrollTo(receivedMessage.scrollX, receivedMessage.scrollY);
        return Promise.resolve({ ok: true });
      case "GREP":
        return Promise.resolve(
          grepPage(
            receivedMessage.query,
            receivedMessage.filters || [],
          ),
        );
      case "GET_CONTENT":
        return Promise.resolve(getPageContent());
      case "OPEN_SEARCH_CURRENT_PAGE":
        if (!hasLivePanelHost())
          getConfig().then((config) => openPanel(() => openSearchCurrentPage(config)))
            .catch(() => showFeedback("Panel failed to open"));
        return Promise.resolve({ ok: true });
      case "OPEN_TAB_MANAGER":
        if (!hasLivePanelHost())
          getConfig().then((config) => openPanel(() => openTabManager(config)))
            .catch(() => showFeedback("Panel failed to open"));
        return Promise.resolve({ ok: true });
      case "OPEN_FRECENCY":
        if (!hasLivePanelHost())
          getConfig().then((config) => openPanel(() => openSearchOpenTabs(config)))
            .catch(() => showFeedback("Panel failed to open"));
        return Promise.resolve({ ok: true });
      case "OPEN_BOOKMARKS":
        if (!hasLivePanelHost())
          getConfig().then((config) => openPanel(() => openBookmarkOverlay(config)))
            .catch(() => showFeedback("Panel failed to open"));
        return Promise.resolve({ ok: true });
      case "SHOW_SESSION_RESTORE":
        if (!hasLivePanelHost())
          openSessionRestoreOverlay();
        return Promise.resolve({ ok: true });
      case "SCROLL_TO_TEXT":
        scrollToText(receivedMessage.text);
        return Promise.resolve({ ok: true });
      case "TAB_MANAGER_ADDED_FEEDBACK":
        showFeedback(
          receivedMessage.alreadyAdded
            ? `Already in Tab Manager [${receivedMessage.slot}]`
            : `Added to Tab Manager [${receivedMessage.slot}]`,
        );
        return Promise.resolve({ ok: true });
      case "TAB_MANAGER_FULL_FEEDBACK":
        showFeedback(`Tab Manager is full (${receivedMessage.max}/${receivedMessage.max})`);
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
