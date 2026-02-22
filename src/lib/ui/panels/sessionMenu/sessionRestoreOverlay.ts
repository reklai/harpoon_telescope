import { loadKeybindings, matchesAction, keyToDisplay } from "../../../common/contracts/keybindings";
import {
  createPanelHost,
  removePanelHost,
  registerPanelCleanup,
  getBaseStyles,
  footerRowHtml,
  vimBadgeHtml,
  dismissPanel,
} from "../../../common/utils/panelHost";
import { escapeHtml } from "../../../common/utils/helpers";
import { showFeedback } from "../../../common/utils/feedback";
import { toastMessages } from "../../../common/utils/toastMessages";
import { listSessions, loadSessionByName } from "../../../adapters/runtime/sessionApi";
import { moveVisibleSelectionByDirection, moveVisibleSelectionFromWheel } from "../../../core/panel/panelListController";
import restoreStyles from "./session.css";

function reportSessionError(context: string, feedbackMessage: string, error: unknown): void {
  console.error(`[Harpoon Telescope] ${context}:`, error);
  showFeedback(feedbackMessage);
}

export async function openSessionRestoreOverlay(): Promise<void> {
  try {
    const sessions = await listSessions();
    if (sessions.length === 0) return;

    const config = await loadKeybindings();
    const { host, shadow } = createPanelHost();

    const style = document.createElement("style");
    style.textContent = getBaseStyles() + restoreStyles;
    shadow.appendChild(style);

    const container = document.createElement("div");
    shadow.appendChild(container);

    let activeIndex = 0;

    function close(): void {
      document.removeEventListener("keydown", keyHandler, true);
      window.removeEventListener("ht-navigation-mode-changed", onNavigationModeChanged);
      removePanelHost();
    }

    function renderRestoreFooter(): void {
      const footer = shadow.querySelector(".ht-footer") as HTMLElement | null;
      if (!footer) return;

      const moveUpKey = keyToDisplay(config.bindings.tabManager.moveUp.key);
      const moveDownKey = keyToDisplay(config.bindings.tabManager.moveDown.key);
      const restoreKey = keyToDisplay(config.bindings.tabManager.jump.key);
      const closeKey = keyToDisplay(config.bindings.tabManager.close.key);
      const navHints = config.navigationMode === "standard"
        ? [
          { key: "j/k", desc: "nav" },
          { key: `${moveUpKey}/${moveDownKey}`, desc: "nav" },
        ]
        : [
          { key: `${moveUpKey}/${moveDownKey}`, desc: "nav" },
        ];

      footer.innerHTML = `${footerRowHtml(navHints)}
      ${footerRowHtml([
        { key: restoreKey, desc: "restore" },
        { key: closeKey, desc: "decline" },
      ])}`;
    }

    function onNavigationModeChanged(): void {
      renderRestoreFooter();
    }

    function render(): void {
      let html = `<div class="ht-backdrop"></div>
        <div class="ht-session-restore-container">
          <div class="ht-titlebar">
            <div class="ht-traffic-lights">
              <button class="ht-dot ht-dot-close" title="Decline (${escapeHtml(keyToDisplay(config.bindings.tabManager.close.key))})"></button>
            </div>
            <span class="ht-titlebar-text">Restore Session?</span>
            ${vimBadgeHtml(config)}
          </div>
          <div class="ht-session-restore-list">`;

      for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        const cls = i === activeIndex ? "ht-session-restore-item active" : "ht-session-restore-item";
        const date = new Date(session.savedAt).toLocaleDateString();
        html += `<div class="${cls}" data-index="${i}">
          <div class="ht-session-restore-name">${escapeHtml(session.name)}</div>
          <span class="ht-session-restore-meta">${session.entries.length} tabs &middot; ${date}</span>
        </div>`;
      }

      html += `</div>
        <div class="ht-footer"></div>
      </div>`;

      container.innerHTML = html;
      renderRestoreFooter();

      const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
      const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;

      backdrop.addEventListener("click", close);
      backdrop.addEventListener("mousedown", (event) => event.preventDefault());
      closeBtn.addEventListener("click", close);

      shadow.querySelectorAll(".ht-session-restore-item").forEach((el) => {
        el.addEventListener("click", () => {
          const idx = parseInt((el as HTMLElement).dataset.index || "", 10);
          if (Number.isNaN(idx)) return;
          void restoreSession(sessions[idx]);
        });
      });

      const listEl = shadow.querySelector(".ht-session-restore-list") as HTMLElement | null;
      if (listEl) {
        listEl.addEventListener("wheel", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (sessions.length === 0) return;
          const next = moveVisibleSelectionFromWheel(
            sessions.map((_, index) => index),
            activeIndex,
            event.deltaY,
          );
          if (next === activeIndex) return;
          activeIndex = next;
          render();
        });
      }

      const activeEl = shadow.querySelector(".ht-session-restore-item.active");
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    }

    async function restoreSession(session: TabManagerSession): Promise<void> {
      try {
        close();
        const result = await loadSessionByName(session.name);
        if (result.ok) {
          showFeedback(toastMessages.sessionRestore(session.name, result.count ?? 0));
        }
      } catch (error) {
        reportSessionError("Restore session failed", "Failed to restore session", error);
      }
    }

    function keyHandler(event: KeyboardEvent): void {
      if (!document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      if (matchesAction(event, config, "tabManager", "close")) {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (matchesAction(event, config, "tabManager", "jump")) {
        event.preventDefault();
        event.stopPropagation();
        if (sessions[activeIndex]) void restoreSession(sessions[activeIndex]);
        return;
      }
      if (matchesAction(event, config, "tabManager", "moveDown")) {
        event.preventDefault();
        event.stopPropagation();
        activeIndex = moveVisibleSelectionByDirection(
          sessions.map((_, index) => index),
          activeIndex,
          "down",
        );
        render();
        return;
      }
      if (matchesAction(event, config, "tabManager", "moveUp")) {
        event.preventDefault();
        event.stopPropagation();
        activeIndex = moveVisibleSelectionByDirection(
          sessions.map((_, index) => index),
          activeIndex,
          "up",
        );
        render();
        return;
      }
      event.stopPropagation();
    }

    document.addEventListener("keydown", keyHandler, true);
    window.addEventListener("ht-navigation-mode-changed", onNavigationModeChanged);
    registerPanelCleanup(close);
    render();
    host.focus();
  } catch (error) {
    console.error("[Harpoon Telescope] Failed to open session restore overlay:", error);
    dismissPanel();
  }
}
