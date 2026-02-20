// Tab Manager overlay — curated list of up to 4 tabs with scroll memory.
// Supports keyboard nav (arrows, vim j/k), number keys 1-4 to jump,
// "w" key to enter swap mode, "d" to delete, "s" to save session, "l" to load session.

import browser from "webextension-polyfill";
import { MAX_TAB_MANAGER_SLOTS, matchesAction, keyToDisplay } from "../shared/keybindings";
import { createPanelHost, removePanelHost, registerPanelCleanup, getBaseStyles, vimBadgeHtml } from "../shared/panelHost";
import { escapeHtml, extractDomain } from "../shared/helpers";
import { showFeedback } from "../shared/feedback";
import {
  SessionContext,
  renderSaveSession,
  renderSessionList,
  renderReplaceSession,
  saveSession,
  loadSession,
  handleSaveSessionKey,
  handleSessionListKey,
  handleReplaceSessionKey,
} from "./session";
import tabManagerStyles from "./tabManager.css";

type ViewMode = "tabManager" | "saveSession" | "sessionList" | "replaceSession";

export async function openTabManager(
  config: KeybindingsConfig,
): Promise<void> {
  try {
    const { host, shadow } = createPanelHost();

    const style = document.createElement("style");
    style.textContent = getBaseStyles() + tabManagerStyles;
    shadow.appendChild(style);

    const container = document.createElement("div");
    shadow.appendChild(container);

    let list = (await browser.runtime.sendMessage({
      type: "TAB_MANAGER_LIST",
    })) as TabManagerEntry[];
    let activeIndex = 0;

    // View mode
    let viewMode: ViewMode = "tabManager";

    // Swap mode state (toggled by "w" key)
    let swapMode = false;
    let swapSourceIndex: number | null = null;

    // Undo buffer — stores the last removed entry for single-slot undo
    let undoEntry: { entry: TabManagerEntry; index: number } | null = null;

    // Session list state
    let sessions: TabManagerSession[] = [];
    let sessionIndex = 0;
    let pendingSaveName = "";

    function close(): void {
      document.removeEventListener("keydown", keyHandler, true);
      removePanelHost();
    }

    function exitSwapMode(): void {
      swapMode = false;
      swapSourceIndex = null;
    }

    // Session context object shared with session-views module
    const sessionCtx: SessionContext = {
      shadow,
      container,
      config,
      get sessions() { return sessions; },
      get sessionIndex() { return sessionIndex; },
      get pendingSaveName() { return pendingSaveName; },
      setSessionIndex(i: number) { sessionIndex = i; },
      setSessions(s: TabManagerSession[]) { sessions = s; },
      setPendingSaveName(name: string) { pendingSaveName = name; },
      setViewMode(mode: ViewMode) { viewMode = mode; },
      render,
      close,
    };

    // -- Tab Manager view render --
    function renderTabManager(): void {
      const titleText = !swapMode
        ? "Tab Manager"
        : swapSourceIndex === null
          ? "Select source item"
          : "Select target to swap";

      let html = `<div class="ht-backdrop"></div>
        <div class="ht-tab-manager-container">
          <div class="ht-titlebar">
            <div class="ht-traffic-lights">
              <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
            </div>
            <span class="ht-titlebar-text">${titleText}</span>
            ${vimBadgeHtml(config)}
          </div>
          <div class="ht-tab-manager-list">`;

      for (let i = 0; i < MAX_TAB_MANAGER_SLOTS; i++) {
        const item = list[i];
        if (item) {
          const shortUrl = extractDomain(item.url);
          const classes = ["ht-tab-manager-item"];
          if (i === activeIndex) classes.push("active");
          if (i === swapSourceIndex) classes.push("swap-source");
          if (item.closed) classes.push("closed");
          html += `<div class="${classes.join(" ")}" data-index="${i}">
            <span class="ht-tab-manager-slot">${item.slot}</span>
            <div class="ht-tab-manager-info">
              <div class="ht-tab-manager-item-title">${escapeHtml(item.title || "Untitled")}</div>
              <div class="ht-tab-manager-item-url">${escapeHtml(shortUrl)}</div>
            </div>
            <button class="ht-tab-manager-delete" data-tab-id="${item.tabId}" title="Remove">\u00d7</button>
          </div>`;
        } else {
          html += `<div class="ht-tab-manager-empty-slot">
            <span class="ht-tab-manager-slot">${i + 1}</span>
            <span>---</span>
          </div>`;
        }
      }

      html += `</div><div class="ht-footer">`;

      const moveUpKey = keyToDisplay(config.bindings.tabManager.moveUp.key);
      const moveDownKey = keyToDisplay(config.bindings.tabManager.moveDown.key);
      const jumpKey = keyToDisplay(config.bindings.tabManager.jump.key);
      const removeKey = keyToDisplay(config.bindings.tabManager.remove.key);
      const swapKey = keyToDisplay(config.bindings.tabManager.swap.key);
      const saveKey = keyToDisplay(config.bindings.tabManager.saveSession.key);
      const loadKey = keyToDisplay(config.bindings.tabManager.loadSession.key);
      const closeKey = keyToDisplay(config.bindings.tabManager.close.key);

      html += `<div class="ht-footer-row">`;
      html += `<span>j/k (vim) ${moveUpKey}/${moveDownKey} nav</span>`;
      html += `<span>${saveKey} save</span>`;
      html += `<span>${loadKey} load</span>`;
      html += `<span>${removeKey} del</span>`;
      html += `</div><div class="ht-footer-row">`;
      html += `<span class="${swapMode ? "ht-footer-hint-active" : ""}">${swapKey} swap</span>`;
      html += `<span>U undo</span>`;
      html += `<span>${jumpKey} jump</span>`;
      html += `<span>${closeKey} close</span>`;
      html += `</div>`;
      html += `</div></div>`;

      container.innerHTML = html;

      // -- Bind events --
      const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
      const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;

      backdrop.addEventListener("click", () => {
        if (swapMode) {
          exitSwapMode();
          render();
          return;
        }
        close();
      });
      backdrop.addEventListener("mousedown", (event) => event.preventDefault());
      closeBtn.addEventListener("click", close);

      // Item click: normal mode -> jump, swap mode -> pick
      shadow.querySelectorAll(".ht-tab-manager-item").forEach((el) => {
        el.addEventListener("click", (event) => {
          const target = (event as MouseEvent).target as HTMLElement;
          if (target.closest(".ht-tab-manager-delete")) return;
          const idx = parseInt((el as HTMLElement).dataset.index!);
          if (!list[idx]) return;

          if (!swapMode) {
            jumpToSlot(list[idx]);
            return;
          }
          performSwapPick(idx);
        });
      });

      // Delete buttons
      shadow.querySelectorAll(".ht-tab-manager-delete").forEach((el) => {
        el.addEventListener("click", async (event) => {
          event.stopPropagation();
          const tabId = parseInt((el as HTMLElement).dataset.tabId!);
          const idx = list.findIndex((item) => item.tabId === tabId);
          if (idx !== -1) undoEntry = { entry: { ...list[idx] }, index: idx };
          await browser.runtime.sendMessage({ type: "TAB_MANAGER_REMOVE", tabId });
          list = (await browser.runtime.sendMessage({
            type: "TAB_MANAGER_LIST",
          })) as TabManagerEntry[];
          activeIndex = Math.min(activeIndex, Math.max(list.length - 1, 0));
          if (swapMode) exitSwapMode();
          render();
        });
      });

      // Scroll active into view
      const activeEl = shadow.querySelector(".ht-tab-manager-item.active");
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    }

    // -- Dispatch render by view mode --
    function render(): void {
      switch (viewMode) {
        case "tabManager":
          renderTabManager();
          break;
        case "saveSession":
          renderSaveSession(sessionCtx);
          break;
        case "sessionList":
          renderSessionList(sessionCtx);
          break;
        case "replaceSession":
          renderReplaceSession(sessionCtx);
          break;
      }
    }

    /** Toggle .active class without rebuilding the DOM (arrow key navigation) */
    function setActiveIndex(newIndex: number): void {
      if (newIndex === activeIndex) return;
      const tabManagerList = shadow.querySelector(".ht-tab-manager-list");
      if (!tabManagerList) return;

      const prev = tabManagerList.querySelector(".ht-tab-manager-item.active");
      if (prev) prev.classList.remove("active");
      activeIndex = newIndex;
      const next = tabManagerList.querySelector(
        `.ht-tab-manager-item[data-index="${activeIndex}"]`,
      );
      if (next) {
        next.classList.add("active");
        next.scrollIntoView({ block: "nearest" });
      }
    }

    // Swap mode: pick source, then target
    function performSwapPick(idx: number): void {
      if (swapSourceIndex === null) {
        swapSourceIndex = idx;
        render();
      } else if (swapSourceIndex === idx) {
        swapSourceIndex = null;
        render();
      } else {
        const srcIdx = swapSourceIndex;
        const temp = list[srcIdx];
        list[srcIdx] = list[idx];
        list[idx] = temp;
        activeIndex = idx;
        swapSourceIndex = null; // Stay in swap mode, ready for next pick
        browser.runtime
          .sendMessage({ type: "TAB_MANAGER_REORDER", list })
          .then(() => browser.runtime.sendMessage({ type: "TAB_MANAGER_LIST" }))
          .then((fresh) => {
            list = fresh as TabManagerEntry[];
            render();
          });
      }
    }

    async function jumpToSlot(item: TabManagerEntry): Promise<void> {
      if (!item) return;
      close();
      await browser.runtime.sendMessage({
        type: "TAB_MANAGER_JUMP",
        slot: item.slot,
      });
    }

    // -- Keyboard handler --
    function keyHandler(event: KeyboardEvent): void {
      if (!document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      // Delegate to session view key handlers
      if (viewMode === "saveSession") {
        handleSaveSessionKey(sessionCtx, event);
        return;
      }
      if (viewMode === "sessionList") {
        handleSessionListKey(sessionCtx, event);
        return;
      }
      if (viewMode === "replaceSession") {
        handleReplaceSessionKey(sessionCtx, event);
        return;
      }

      // -- Tab Manager mode key handling --

      // Number keys 1-4: instant jump to slot
      if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
        const num = parseInt(event.key);
        if (num >= 1 && num <= MAX_TAB_MANAGER_SLOTS) {
          event.preventDefault();
          event.stopPropagation();
          const item = list.find((it) => it.slot === num);
          if (item) jumpToSlot(item);
          return;
        }
      }

      // Swap mode toggle ("w" key)
      if (matchesAction(event, config, "tabManager", "swap")) {
        event.preventDefault();
        event.stopPropagation();
        if (swapMode) {
          exitSwapMode();
        } else {
          swapMode = true;
          swapSourceIndex = null;
        }
        render();
        return;
      }

      // Save session ("s" key)
      if (matchesAction(event, config, "tabManager", "saveSession")) {
        event.preventDefault();
        event.stopPropagation();
        if (list.length === 0) return;
        viewMode = "saveSession";
        render();
        return;
      }

      // Load session ("l" key)
      if (matchesAction(event, config, "tabManager", "loadSession")) {
        event.preventDefault();
        event.stopPropagation();
        (async () => {
          sessions = (await browser.runtime.sendMessage({
            type: "SESSION_LIST",
          })) as TabManagerSession[];
          sessionIndex = 0;
          viewMode = "sessionList";
          render();
        })();
        return;
      }

      if (matchesAction(event, config, "tabManager", "close")) {
        event.preventDefault();
        event.stopPropagation();
        if (swapMode) {
          exitSwapMode();
          render();
          return;
        }
        close();
      } else if (matchesAction(event, config, "tabManager", "moveDown")) {
        event.preventDefault();
        event.stopPropagation();
        if (list.length > 0) {
          const newIdx = Math.min(activeIndex + 1, list.length - 1);
          if (swapMode) {
            activeIndex = newIdx;
            render();
          } else {
            setActiveIndex(newIdx);
          }
        }
      } else if (matchesAction(event, config, "tabManager", "moveUp")) {
        event.preventDefault();
        event.stopPropagation();
        if (list.length > 0) {
          const newIdx = Math.max(activeIndex - 1, 0);
          if (swapMode) {
            activeIndex = newIdx;
            render();
          } else {
            setActiveIndex(newIdx);
          }
        }
      } else if (matchesAction(event, config, "tabManager", "jump")) {
        event.preventDefault();
        event.stopPropagation();
        if (swapMode && list[activeIndex]) {
          performSwapPick(activeIndex);
        } else if (list[activeIndex]) {
          jumpToSlot(list[activeIndex]);
        }
      } else if (matchesAction(event, config, "tabManager", "remove")) {
        event.preventDefault();
        event.stopPropagation();
        if (list[activeIndex]) {
          (async () => {
            undoEntry = { entry: { ...list[activeIndex] }, index: activeIndex };
            await browser.runtime.sendMessage({
              type: "TAB_MANAGER_REMOVE",
              tabId: list[activeIndex].tabId,
            });
            list = (await browser.runtime.sendMessage({
              type: "TAB_MANAGER_LIST",
            })) as TabManagerEntry[];
            activeIndex = Math.min(
              activeIndex,
              Math.max(list.length - 1, 0),
            );
            render();
          })();
        }
      } else if (
        event.key.toLowerCase() === "u"
        && !event.ctrlKey
        && !event.altKey
        && !event.shiftKey
        && !event.metaKey
      ) {
        // Undo last remove
        event.preventDefault();
        event.stopPropagation();
        if (!undoEntry) return;
        if (list.length >= MAX_TAB_MANAGER_SLOTS) {
          undoEntry = null;
          showFeedback(`Tab Manager full (max ${MAX_TAB_MANAGER_SLOTS})`);
          return;
        }
        (async () => {
          const restoreIdx = Math.min(undoEntry!.index, list.length);
          list.splice(restoreIdx, 0, undoEntry!.entry);
          undoEntry = null;
          await browser.runtime.sendMessage({ type: "TAB_MANAGER_REORDER", list });
          list = (await browser.runtime.sendMessage({
            type: "TAB_MANAGER_LIST",
          })) as TabManagerEntry[];
          activeIndex = restoreIdx;
          render();
        })();
      } else {
        // Block all other keys from reaching the page
        event.stopPropagation();
      }
    }

    document.addEventListener("keydown", keyHandler, true);
    registerPanelCleanup(close);
    render();
    host.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open tab manager overlay:", err);
  }
}
