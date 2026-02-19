// Harpoon overlay panel — curated list of up to 4 tabs with scroll memory.
// Supports keyboard nav (arrows, vim j/k), number keys 1-4 to jump,
// "w" key to enter swap mode, "d" to delete, "s" to save session, "l" to load session.

import browser from "webextension-polyfill";
import { MAX_HARPOON_SLOTS, matchesAction, keyToDisplay, saveKeybindings } from "./keybindings";
import { createPanelHost, removePanelHost, getBaseStyles, vimBadgeHtml } from "./panel-host";
import { escapeHtml, extractDomain } from "./helpers";
import { showFeedback } from "./feedback";
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
} from "./session-views";

type ViewMode = "harpoon" | "saveSession" | "sessionList" | "replaceSession";

export async function openHarpoonOverlay(
  config: KeybindingsConfig,
): Promise<void> {
  try {
    const { host, shadow } = createPanelHost();

    const style = document.createElement("style");
    style.textContent =
      getBaseStyles() +
      `
      .ht-harpoon-container {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 380px; max-width: 90vw; background: #1e1e1e; border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px; overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
        display: flex; flex-direction: column;
      }
      .ht-harpoon-list { max-height: min(340px, 50vh); overflow-y: auto; }
      .ht-harpoon-item {
        display: flex; align-items: center; padding: 8px 14px; gap: 10px;
        cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.04);
        transition: background 0.1s, opacity 0.15s;
        user-select: none; position: relative;
      }
      .ht-harpoon-item:hover { background: rgba(255,255,255,0.06); }
      .ht-harpoon-item.active { background: rgba(255,255,255,0.08); border-left: 2px solid #0a84ff; }
      .ht-harpoon-item.closed { opacity: 0.5; }
      .ht-harpoon-item.closed .ht-harpoon-slot { background: rgba(255,255,255,0.04); }
      .ht-harpoon-item.swap-source {
        background: rgba(10,132,255,0.15);
        border-left: 2px solid #febc2e;
      }
      .ht-harpoon-slot {
        background: rgba(255,255,255,0.08); color: #e0e0e0; width: 22px; height: 22px;
        border: none; border-radius: 5px;
        display: flex; align-items: center; justify-content: center;
        font-weight: 600; font-size: 12px; flex-shrink: 0;
        pointer-events: none;
      }
      .ht-harpoon-item.active .ht-harpoon-slot {
        background: #0a84ff; color: #fff;
      }
      .ht-harpoon-info { flex: 1; overflow: hidden; pointer-events: none; }
      .ht-harpoon-item-title {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-size: 12px; color: #e0e0e0;
      }
      .ht-harpoon-item-url {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-size: 10px; color: #808080; margin-top: 2px;
      }
      .ht-harpoon-delete {
        color: #808080; cursor: pointer; font-size: 14px; transition: color 0.2s;
        background: none; border: none; font-family: inherit; padding: 4px;
        line-height: 1;
      }
      .ht-harpoon-delete:hover { color: #ff5f57; }
      .ht-harpoon-empty {
        padding: 32px 24px; text-align: center; color: #808080;
        line-height: 1.6; font-size: 12px;
      }
      .ht-harpoon-empty-slot {
        display: flex; align-items: center; padding: 8px 14px; gap: 10px;
        border-bottom: 1px solid rgba(255,255,255,0.04); color: #555;
      }
      .ht-harpoon-empty-slot .ht-harpoon-slot {
        background: rgba(255,255,255,0.04); color: #555;
      }
      .ht-footer-hint-active { color: #0a84ff; }
      .ht-session-input-wrap {
        display: flex; align-items: center; padding: 8px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06); background: #252525;
      }
      .ht-session-prompt { color: #0a84ff; margin-right: 8px; font-weight: 600; font-size: 13px; }
      .ht-session-input {
        flex: 1; background: transparent; border: none; outline: none;
        color: #e0e0e0; font-family: inherit; font-size: 13px; caret-color: #0a84ff;
      }
      .ht-session-input::placeholder { color: #666; }
      .ht-session-item {
        display: flex; align-items: center; padding: 8px 14px; gap: 10px;
        cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.04);
        transition: background 0.1s; user-select: none;
      }
      .ht-session-item:hover { background: rgba(255,255,255,0.06); }
      .ht-session-item.active { background: rgba(255,255,255,0.08); border-left: 2px solid #0a84ff; }
      .ht-session-name {
        flex: 1; font-size: 12px; color: #e0e0e0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ht-session-meta {
        font-size: 10px; color: #808080; flex-shrink: 0;
      }
      .ht-session-delete {
        color: #808080; cursor: pointer; font-size: 14px; transition: color 0.2s;
        background: none; border: none; font-family: inherit; padding: 4px;
        line-height: 1; flex-shrink: 0;
      }
      .ht-session-delete:hover { color: #ff5f57; }
      .ht-session-empty {
        padding: 24px; text-align: center; color: #808080; font-size: 12px;
      }
    `;
    shadow.appendChild(style);

    const container = document.createElement("div");
    shadow.appendChild(container);

    let list = (await browser.runtime.sendMessage({
      type: "HARPOON_LIST",
    })) as HarpoonEntry[];
    let activeIndex = 0;

    // View mode
    let viewMode: ViewMode = "harpoon";

    // Swap mode state (toggled by "w" key)
    let swapMode = false;
    let swapSourceIndex: number | null = null;

    // Session list state
    let sessions: HarpoonSession[] = [];
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
      setSessions(s: HarpoonSession[]) { sessions = s; },
      setPendingSaveName(name: string) { pendingSaveName = name; },
      setViewMode(mode: ViewMode) { viewMode = mode; },
      render,
      close,
    };

    // -- Harpoon view render --
    function renderHarpoon(): void {
      const titleText = !swapMode
        ? "Tab Manager"
        : swapSourceIndex === null
          ? "Select source item"
          : "Select target to swap";

      let html = `<div class="ht-backdrop"></div>
        <div class="ht-harpoon-container">
          <div class="ht-titlebar">
            <div class="ht-traffic-lights">
              <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
            </div>
            <span class="ht-titlebar-text">${titleText}</span>
            ${vimBadgeHtml(config)}
          </div>
          <div class="ht-harpoon-list">`;

      for (let i = 0; i < MAX_HARPOON_SLOTS; i++) {
        const item = list[i];
        if (item) {
          const shortUrl = extractDomain(item.url);
          const classes = ["ht-harpoon-item"];
          if (i === activeIndex) classes.push("active");
          if (i === swapSourceIndex) classes.push("swap-source");
          if (item.closed) classes.push("closed");
          html += `<div class="${classes.join(" ")}" data-index="${i}">
            <span class="ht-harpoon-slot">${item.slot}</span>
            <div class="ht-harpoon-info">
              <div class="ht-harpoon-item-title">${escapeHtml(item.title || "Untitled")}</div>
              <div class="ht-harpoon-item-url">${escapeHtml(shortUrl)}</div>
            </div>
            <button class="ht-harpoon-delete" data-tab-id="${item.tabId}" title="Remove">\u00d7</button>
          </div>`;
        } else {
          html += `<div class="ht-harpoon-empty-slot">
            <span class="ht-harpoon-slot">${i + 1}</span>
            <span>---</span>
          </div>`;
        }
      }

      html += `</div><div class="ht-footer">`;

      const moveUpKey = keyToDisplay(config.bindings.harpoon.moveUp.key);
      const moveDownKey = keyToDisplay(config.bindings.harpoon.moveDown.key);
      const jumpKey = keyToDisplay(config.bindings.harpoon.jump.key);
      const removeKey = keyToDisplay(config.bindings.harpoon.remove.key);
      const swapKey = keyToDisplay(config.bindings.harpoon.swap.key);
      const saveKey = keyToDisplay(config.bindings.harpoon.saveSession.key);
      const loadKey = keyToDisplay(config.bindings.harpoon.loadSession.key);
      const closeKey = keyToDisplay(config.bindings.harpoon.close.key);

      html += `<div class="ht-footer-row">`;
      html += `<span>j/k (vim) ${moveUpKey}/${moveDownKey} nav</span>`;
      html += `<span>${jumpKey} jump</span>`;
      html += `<span>${removeKey} del</span>`;
      html += `<span class="${swapMode ? "ht-footer-hint-active" : ""}">${swapKey} swap</span>`;
      html += `</div><div class="ht-footer-row">`;
      html += `<span>${saveKey} save</span>`;
      html += `<span>${loadKey} load</span>`;
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
      backdrop.addEventListener("mousedown", (e) => e.preventDefault());
      closeBtn.addEventListener("click", close);

      // Item click: normal mode -> jump, swap mode -> pick
      shadow.querySelectorAll(".ht-harpoon-item").forEach((el) => {
        el.addEventListener("click", (e) => {
          const target = (e as MouseEvent).target as HTMLElement;
          if (target.closest(".ht-harpoon-delete")) return;
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
      shadow.querySelectorAll(".ht-harpoon-delete").forEach((el) => {
        el.addEventListener("click", async (e) => {
          e.stopPropagation();
          const tabId = parseInt((el as HTMLElement).dataset.tabId!);
          await browser.runtime.sendMessage({ type: "HARPOON_REMOVE", tabId });
          list = (await browser.runtime.sendMessage({
            type: "HARPOON_LIST",
          })) as HarpoonEntry[];
          activeIndex = Math.min(activeIndex, Math.max(list.length - 1, 0));
          if (swapMode) exitSwapMode();
          render();
        });
      });

      // Scroll active into view
      const activeEl = shadow.querySelector(".ht-harpoon-item.active");
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    }

    // -- Dispatch render by view mode --
    function render(): void {
      switch (viewMode) {
        case "harpoon":
          renderHarpoon();
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
      const harpoonList = shadow.querySelector(".ht-harpoon-list");
      if (!harpoonList) return;

      const prev = harpoonList.querySelector(".ht-harpoon-item.active");
      if (prev) prev.classList.remove("active");
      activeIndex = newIndex;
      const next = harpoonList.querySelector(
        `.ht-harpoon-item[data-index="${activeIndex}"]`,
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
          .sendMessage({ type: "HARPOON_REORDER", list })
          .then(() => browser.runtime.sendMessage({ type: "HARPOON_LIST" }))
          .then((fresh) => {
            list = fresh as HarpoonEntry[];
            render();
          });
      }
    }

    async function jumpToSlot(item: HarpoonEntry): Promise<void> {
      if (!item) return;
      close();
      await browser.runtime.sendMessage({
        type: "HARPOON_JUMP",
        slot: item.slot,
      });
    }

    // -- Keyboard handler --
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

      // Delegate to session view key handlers
      if (viewMode === "saveSession") {
        handleSaveSessionKey(sessionCtx, e);
        return;
      }
      if (viewMode === "sessionList") {
        handleSessionListKey(sessionCtx, e);
        return;
      }
      if (viewMode === "replaceSession") {
        handleReplaceSessionKey(sessionCtx, e);
        return;
      }

      // -- Harpoon mode key handling --

      // Number keys 1-4: instant jump to slot
      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        const num = parseInt(e.key);
        if (num >= 1 && num <= MAX_HARPOON_SLOTS) {
          e.preventDefault();
          e.stopPropagation();
          const item = list.find((it) => it.slot === num);
          if (item) jumpToSlot(item);
          return;
        }
      }

      // Swap mode toggle ("w" key)
      if (matchesAction(e, config, "harpoon", "swap")) {
        e.preventDefault();
        e.stopPropagation();
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
      if (matchesAction(e, config, "harpoon", "saveSession")) {
        e.preventDefault();
        e.stopPropagation();
        if (list.length === 0) return;
        viewMode = "saveSession";
        render();
        return;
      }

      // Load session ("l" key)
      if (matchesAction(e, config, "harpoon", "loadSession")) {
        e.preventDefault();
        e.stopPropagation();
        (async () => {
          sessions = (await browser.runtime.sendMessage({
            type: "SESSION_LIST",
          })) as HarpoonSession[];
          sessionIndex = 0;
          viewMode = "sessionList";
          render();
        })();
        return;
      }

      if (matchesAction(e, config, "harpoon", "close")) {
        e.preventDefault();
        e.stopPropagation();
        if (swapMode) {
          exitSwapMode();
          render();
          return;
        }
        close();
      } else if (matchesAction(e, config, "harpoon", "moveDown")) {
        e.preventDefault();
        e.stopPropagation();
        if (list.length > 0) {
          const newIdx = Math.min(activeIndex + 1, list.length - 1);
          if (swapMode) {
            activeIndex = newIdx;
            render();
          } else {
            setActiveIndex(newIdx);
          }
        }
      } else if (matchesAction(e, config, "harpoon", "moveUp")) {
        e.preventDefault();
        e.stopPropagation();
        if (list.length > 0) {
          const newIdx = Math.max(activeIndex - 1, 0);
          if (swapMode) {
            activeIndex = newIdx;
            render();
          } else {
            setActiveIndex(newIdx);
          }
        }
      } else if (matchesAction(e, config, "harpoon", "jump")) {
        e.preventDefault();
        e.stopPropagation();
        if (swapMode && list[activeIndex]) {
          performSwapPick(activeIndex);
        } else if (list[activeIndex]) {
          jumpToSlot(list[activeIndex]);
        }
      } else if (matchesAction(e, config, "harpoon", "remove")) {
        e.preventDefault();
        e.stopPropagation();
        if (list[activeIndex]) {
          (async () => {
            await browser.runtime.sendMessage({
              type: "HARPOON_REMOVE",
              tabId: list[activeIndex].tabId,
            });
            list = (await browser.runtime.sendMessage({
              type: "HARPOON_LIST",
            })) as HarpoonEntry[];
            activeIndex = Math.min(
              activeIndex,
              Math.max(list.length - 1, 0),
            );
            render();
          })();
        }
      } else {
        // Block all other keys from reaching the page
        e.stopPropagation();
      }
    }

    document.addEventListener("keydown", keyHandler, true);
    render();
    host.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open harpoon overlay:", err);
  }
}
