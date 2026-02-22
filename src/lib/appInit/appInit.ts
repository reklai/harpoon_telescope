// App init — wires up keybindings, message routing, and panel lifecycle.
// Imported by contentScript.ts as the single bootstrap for all content-side logic.

import browser from "webextension-polyfill";
import { DEFAULT_KEYBINDINGS, matchesAction } from "../shared/keybindings";
import { grepPage, getPageContent } from "../searchCurrentPage/grep";
import { scrollToText } from "../shared/scroll";
import { showFeedback } from "../shared/feedback";
import { toastMessages } from "../shared/toastMessages";
import { openTabManager } from "../tabManager/tabManager";
import { openSessionMenu } from "../sessionMenu/sessionMenu";
import { openSearchCurrentPage } from "../searchCurrentPage/searchCurrentPage";
import { openSearchOpenTabs } from "../searchOpenTabs/searchOpenTabs";
import { openHelpOverlay } from "../help/help";
import { dismissPanel } from "../shared/panelHost";
import { ContentRuntimeMessage } from "../shared/runtimeMessages";
import { openSessionRestoreOverlay } from "../sessionMenu/session";
import {
  addCurrentTabToTabManager,
  cycleTabManagerSlot,
  jumpToTabManagerSlot,
} from "../adapters/runtime/tabManagerApi";
import { fetchKeybindings } from "../adapters/runtime/keybindingsApi";
import { notifyContentScriptReady } from "../adapters/runtime/contentLifecycleApi";

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

    configLoadPromise = fetchKeybindings()
      .then((loadedConfig) => {
        cachedConfig = loadedConfig;
        cachedConfig.navigationMode = "standard";
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
        nextConfig.navigationMode = "standard";
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
          showFeedback(toastMessages.panelOpenFailed);
        });
      }
    } catch (err) {
      console.error("[Harpoon Telescope] panel open failed:", err);
      dismissPanel();
      showFeedback(toastMessages.panelOpenFailed);
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

  interface GlobalActionRegistration {
    action: keyof KeybindingsConfig["bindings"]["global"] | string;
    run: (config: KeybindingsConfig) => void;
  }

  const globalActionRegistry: GlobalActionRegistration[] = [
    {
      action: "openTabManager",
      run: (config) => openPanel(() => openTabManager(config)),
    },
    {
      action: "addTab",
      run: () => { void addCurrentTabToTabManager(); },
    },
    {
      action: "jumpSlot1",
      run: () => { void jumpToTabManagerSlot(1); },
    },
    {
      action: "jumpSlot2",
      run: () => { void jumpToTabManagerSlot(2); },
    },
    {
      action: "jumpSlot3",
      run: () => { void jumpToTabManagerSlot(3); },
    },
    {
      action: "jumpSlot4",
      run: () => { void jumpToTabManagerSlot(4); },
    },
    {
      action: "cyclePrev",
      run: () => { void cycleTabManagerSlot("prev"); },
    },
    {
      action: "cycleNext",
      run: () => { void cycleTabManagerSlot("next"); },
    },
    {
      action: "searchInPage",
      run: (config) => openPanel(() => openSearchCurrentPage(config)),
    },
    {
      action: "openFrecency",
      run: (config) => openPanel(() => openSearchOpenTabs(config)),
    },
    {
      action: "openSessions",
      run: (config) => openPanel(() => openSessionMenu(config)),
    },
    {
      action: "openSessionSave",
      run: (config) => openPanel(() => openSessionMenu(config, "saveSession")),
    },
    {
      action: "openHelp",
      run: (config) => openPanel(() => openHelpOverlay(config)),
    },
  ];

  function tryHandleGlobalActions(event: KeyboardEvent, config: KeybindingsConfig): boolean {
    // Block all actions when a panel is already open — user must close it first.
    if (hasLivePanelHost()) return false;

    for (const registration of globalActionRegistry) {
      if (!matchesAction(event, config, "global", registration.action)) continue;
      event.preventDefault();
      event.stopPropagation();
      registration.run(config);
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
            .catch(() => showFeedback(toastMessages.panelOpenFailed));
        return Promise.resolve({ ok: true });
      case "OPEN_TAB_MANAGER":
        if (!hasLivePanelHost())
          getConfig().then((config) => openPanel(() => openTabManager(config)))
            .catch(() => showFeedback(toastMessages.panelOpenFailed));
        return Promise.resolve({ ok: true });
      case "OPEN_FRECENCY":
        if (!hasLivePanelHost())
          getConfig().then((config) => openPanel(() => openSearchOpenTabs(config)))
            .catch(() => showFeedback(toastMessages.panelOpenFailed));
        return Promise.resolve({ ok: true });
      case "OPEN_SESSIONS":
        if (!hasLivePanelHost())
          getConfig().then((config) => openPanel(() => openSessionMenu(config)))
            .catch(() => showFeedback(toastMessages.panelOpenFailed));
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
            ? toastMessages.tabManagerAlreadyAdded(receivedMessage.slot)
            : toastMessages.tabManagerAdded(receivedMessage.slot),
        );
        return Promise.resolve({ ok: true });
      case "TAB_MANAGER_FULL_FEEDBACK":
        showFeedback(toastMessages.tabManagerFull(receivedMessage.max));
        return Promise.resolve({ ok: true });
    }
  }

  browser.runtime.onMessage.addListener(messageHandler);

  // Signal background that this content script is ready to receive messages
  // (used for deferred scroll restoration on re-opened tabs)
  notifyContentScriptReady().catch(() => {});

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
