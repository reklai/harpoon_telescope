import browser from "webextension-polyfill";
import {
  createPanelHost,
  removePanelHost,
  registerPanelCleanup,
  getBaseStyles,
  dismissPanel,
} from "../shared/panelHost";
import { showFeedback } from "../shared/feedback";
import { toastMessages } from "../shared/toastMessages";
import previewPaneStyles from "../shared/previewPane.css";
import tabManagerStyles from "../tabManager/tabManager.css";
import sessionStyles from "../tabManager/session.css";
import sessionMenuStyles from "./sessionMenu.css";
import {
  SessionContext,
  SessionPanelMode,
  refreshSessionViewFooter,
  renderSaveSession,
  renderSessionList,
  renderReplaceSession,
  handleSaveSessionKey,
  handleSessionListKey,
  handleReplaceSessionKey,
  resetSessionTransientState,
} from "../tabManager/session";

type SessionMenuView = SessionPanelMode;

async function fetchSessionsWithRetry(): Promise<TabManagerSession[]> {
  const retryDelaysMs = [0, 90, 240, 450];
  let lastError: unknown = null;
  for (const delay of retryDelaysMs) {
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    try {
      return (await browser.runtime.sendMessage({ type: "SESSION_LIST" })) as TabManagerSession[];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Failed to load sessions");
}

export async function openSessionMenu(
  config: KeybindingsConfig,
  initialView: SessionPanelMode = "sessionList",
): Promise<void> {
  try {
    const { host, shadow } = createPanelHost();

    const style = document.createElement("style");
    style.textContent = getBaseStyles() + previewPaneStyles + tabManagerStyles + sessionStyles + sessionMenuStyles;
    shadow.appendChild(style);

    const container = document.createElement("div");
    shadow.appendChild(container);

    let viewMode: SessionMenuView = initialView;
    let sessions: TabManagerSession[] = [];
    let sessionIndex = 0;
    let pendingSaveName = "";
    let sessionFilterQuery = "";
    resetSessionTransientState();

    function close(): void {
      document.removeEventListener("keydown", keyHandler, true);
      window.removeEventListener("ht-vim-mode-changed", onVimModeChanged);
      resetSessionTransientState();
      removePanelHost();
    }

    function failClose(context: string, error: unknown): void {
      console.error(`[Harpoon Telescope] ${context}; dismissing session menu.`, error);
      showFeedback(toastMessages.sessionMenuFailed);
      close();
    }

    async function refreshSessions(): Promise<void> {
      try {
        sessions = await fetchSessionsWithRetry();
      } catch (error) {
        sessions = [];
        console.error("[Harpoon Telescope] Session fetch failed.", error);
      }
    }

    const sessionCtx: SessionContext = {
      shadow,
      container,
      config,
      get sessions() { return sessions; },
      get sessionIndex() { return sessionIndex; },
      get pendingSaveName() { return pendingSaveName; },
      get sessionFilterQuery() { return sessionFilterQuery; },
      setSessionIndex(index: number) { sessionIndex = index; },
      setSessions(nextSessions: TabManagerSession[]) { sessions = nextSessions; },
      setPendingSaveName(name: string) { pendingSaveName = name; },
      setSessionFilterQuery(query: string) { sessionFilterQuery = query; },
      setViewMode(mode: "tabManager" | SessionPanelMode) {
        viewMode = mode === "tabManager" ? initialView : mode;
      },
      render,
      close,
    };

    function onVimModeChanged(): void {
      refreshSessionViewFooter(sessionCtx, viewMode);
    }

    function render(): void {
      if (viewMode === "saveSession") {
        void renderSaveSession(sessionCtx).catch((error) => {
          failClose("Render save-session view failed", error);
        });
        return;
      }

      if (viewMode === "sessionList") {
        renderSessionList(sessionCtx);
        return;
      }

      renderReplaceSession(sessionCtx);
    }

    function keyHandler(event: KeyboardEvent): void {
      if (!document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      if (viewMode === "saveSession") {
        handleSaveSessionKey(sessionCtx, event);
        return;
      }
      if (viewMode === "sessionList") {
        handleSessionListKey(sessionCtx, event);
        return;
      }
      handleReplaceSessionKey(sessionCtx, event);
    }

    if (viewMode === "sessionList") {
      // Render immediately so the search input is ready without waiting
      // on background session fetch retries / worker warm-up.
      sessions = [];
      sessionIndex = 0;
      sessionFilterQuery = "";
    } else if (viewMode === "saveSession") {
      pendingSaveName = "";
    }

    document.addEventListener("keydown", keyHandler, true);
    window.addEventListener("ht-vim-mode-changed", onVimModeChanged);
    registerPanelCleanup(close);
    render();

    if (viewMode === "sessionList") {
      void (async () => {
        await refreshSessions();
        if (!document.getElementById("ht-panel-host")) return;
        if (sessions.length > 0) {
          sessionIndex = Math.min(sessionIndex, sessions.length - 1);
        } else {
          sessionIndex = 0;
        }
        render();
      })();
    }

    host.focus();
  } catch (error) {
    console.error("[Harpoon Telescope] Failed to open session menu:", error);
    dismissPanel();
  }
}
