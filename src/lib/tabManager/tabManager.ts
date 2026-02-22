// Tab Manager overlay — curated list of up to 4 tabs with scroll memory.
// Supports keyboard nav (arrows, vim j/k), number keys 1-4 to jump,
// "w" key to enter swap mode, and "d" to delete.

import { MAX_TAB_MANAGER_SLOTS, matchesAction, keyToDisplay } from "../shared/keybindings";
import {
  createPanelHost,
  removePanelHost,
  registerPanelCleanup,
  getBaseStyles,
  footerRowHtml,
  vimBadgeHtml,
  dismissPanel,
} from "../shared/panelHost";
import { escapeHtml, extractDomain } from "../shared/helpers";
import { showFeedback } from "../shared/feedback";
import { toastMessages } from "../shared/toastMessages";
import tabManagerStyles from "./tabManager.css";
import {
  jumpToTabManagerSlot,
  listTabManagerEntries,
  listTabManagerEntriesWithRetry,
  removeTabManagerEntry,
  reorderTabManagerEntries,
} from "../adapters/runtime/tabManagerApi";
import {
  movePanelListIndex,
  movePanelListIndexByDirection,
  movePanelListIndexFromWheel,
  movePanelListIndexHalfPage,
} from "../core/panel/panelListController";

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

    let list = await listTabManagerEntriesWithRetry();
    let activeIndex = 0;

    // Swap mode state (toggled by "w" key)
    let swapMode = false;
    let swapSourceIndex: number | null = null;

    // Undo buffer — stores the last removed entry for single-slot undo
    let undoEntry: { entry: TabManagerEntry; index: number } | null = null;

    const moveUpKey = keyToDisplay(config.bindings.tabManager.moveUp.key);
    const moveDownKey = keyToDisplay(config.bindings.tabManager.moveDown.key);
    const jumpKey = keyToDisplay(config.bindings.tabManager.jump.key);
    const removeKey = keyToDisplay(config.bindings.tabManager.remove.key);
    const swapKey = keyToDisplay(config.bindings.tabManager.swap.key);
    const undoKey = keyToDisplay(config.bindings.tabManager.undo.key);
    const closeKey = keyToDisplay(config.bindings.tabManager.close.key);

    function close(): void {
      document.removeEventListener("keydown", keyHandler, true);
      window.removeEventListener("ht-navigation-mode-changed", onNavigationModeChanged);
      removePanelHost();
    }

    function failToSafeTabManagerState(context: string, error: unknown): void {
      console.error(`[Harpoon Telescope] ${context}:`, error);
      showFeedback(toastMessages.tabManagerActionFailed);
      exitSwapMode();
      try {
        renderTabManager();
      } catch (renderError) {
        console.error("[Harpoon Telescope] Failed to recover tab manager panel:", renderError);
        close();
      }
    }

    function exitSwapMode(): void {
      swapMode = false;
      swapSourceIndex = null;
    }

    function buildTabManagerFooterHtml(): string {
      const navHints = config.navigationMode === "standard"
        ? [
          { key: "j/k", desc: "nav" },
          { key: `${moveUpKey}/${moveDownKey}`, desc: "nav" },
          { key: "Ctrl+D/U", desc: "half-page" },
        ]
        : [
          { key: `${moveUpKey}/${moveDownKey}`, desc: "nav" },
        ];

      return `${footerRowHtml(navHints)}
      ${footerRowHtml([
        { key: undoKey, desc: "undo" },
        { key: swapKey, desc: "swap", active: swapMode },
        { key: removeKey, desc: "del" },
        { key: jumpKey, desc: "jump" },
        { key: closeKey, desc: "close" },
      ])}`;
    }

    function refreshTabManagerFooter(): void {
      const footerEl = shadow.querySelector(".ht-footer") as HTMLElement | null;
      if (!footerEl) return;
      footerEl.innerHTML = buildTabManagerFooterHtml();
    }

    function onNavigationModeChanged(): void {
      refreshTabManagerFooter();
    }

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
              <button class="ht-dot ht-dot-close" title="Close (${escapeHtml(closeKey)})"></button>
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
          html += `<div class="ht-tab-manager-empty-slot" data-index="${i}">
            <span class="ht-tab-manager-slot">${i + 1}</span>
            <span>---</span>
          </div>`;
        }
      }

      html += `</div><div class="ht-footer">${buildTabManagerFooterHtml()}</div></div>`;

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
          try {
            const tabId = parseInt((el as HTMLElement).dataset.tabId!);
            const idx = list.findIndex((item) => item.tabId === tabId);
            if (idx !== -1) undoEntry = { entry: { ...list[idx] }, index: idx };
            await removeTabManagerEntry(tabId);
            list = await listTabManagerEntries();
            activeIndex = Math.min(activeIndex, Math.max(list.length - 1, 0));
            if (swapMode) exitSwapMode();
            render();
          } catch (error) {
            failToSafeTabManagerState("Delete tab-manager entry failed", error);
          }
        });
      });

      // Scroll active into view
      const activeEl = shadow.querySelector(".ht-tab-manager-item.active");
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });

      const listEl = shadow.querySelector(".ht-tab-manager-list") as HTMLElement | null;
      if (listEl) {
        listEl.addEventListener("wheel", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (list.length === 0) return;
          const next = movePanelListIndexFromWheel(list.length, activeIndex, event.deltaY);
          if (swapMode) {
            activeIndex = next;
            render();
          } else {
            setActiveIndex(next);
          }
        });
      }
    }

    // -- Render --
    function render(): void {
      renderTabManager();
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
        reorderTabManagerEntries(list)
          .then(() => listTabManagerEntries())
          .then((fresh) => {
            list = fresh;
            render();
          })
          .catch(() => {
            showFeedback(toastMessages.tabManagerSwapFailed);
            exitSwapMode();
            render();
          });
      }
    }

    async function jumpToSlot(item: TabManagerEntry): Promise<void> {
      if (!item) return;
      close();
      try {
        await jumpToTabManagerSlot(item.slot);
      } catch (error) {
        console.error("[Harpoon Telescope] Jump to tab-manager slot failed:", error);
        showFeedback(toastMessages.tabManagerJumpFailed);
      }
    }

    function getHalfPageStep(): number {
      const listEl = shadow.querySelector(".ht-tab-manager-list") as HTMLElement | null;
      const itemEl = shadow.querySelector(".ht-tab-manager-item") as HTMLElement | null;
      const itemHeight = Math.max(1, itemEl?.offsetHeight ?? 36);
      const rows = Math.max(1, Math.floor((listEl?.clientHeight ?? (itemHeight * 6)) / itemHeight));
      return Math.max(1, Math.floor(rows / 2));
    }

    function setIndexWithMode(newIdx: number): void {
      const bounded = movePanelListIndex(list.length, newIdx, 0);
      if (swapMode) {
        activeIndex = bounded;
        render();
      } else {
        setActiveIndex(bounded);
      }
    }

    // -- Keyboard handler --
    function keyHandler(event: KeyboardEvent): void {
      if (!document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      // -- Tab Manager mode key handling --

      if (
        config.navigationMode === "standard"
        && event.ctrlKey
        && !event.altKey
        && !event.metaKey
      ) {
        const lowerKey = event.key.toLowerCase();
        if (lowerKey === "d" || lowerKey === "u") {
          event.preventDefault();
          event.stopPropagation();
          if (list.length > 0) {
            const nextIndex = movePanelListIndexHalfPage(
              list.length,
              activeIndex,
              getHalfPageStep(),
              lowerKey === "d" ? "down" : "up",
            );
            setIndexWithMode(nextIndex);
          }
          return;
        }
      }

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
          const newIdx = movePanelListIndexByDirection(list.length, activeIndex, "down");
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
          const newIdx = movePanelListIndexByDirection(list.length, activeIndex, "up");
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
            try {
              undoEntry = { entry: { ...list[activeIndex] }, index: activeIndex };
              await removeTabManagerEntry(list[activeIndex].tabId);
              list = await listTabManagerEntries();
              activeIndex = Math.min(
                activeIndex,
                Math.max(list.length - 1, 0),
              );
              render();
            } catch (error) {
              failToSafeTabManagerState("Remove tab-manager entry failed", error);
            }
          })();
        }
      } else if (matchesAction(event, config, "tabManager", "undo")) {
        // Undo last remove
        event.preventDefault();
        event.stopPropagation();
        if (!undoEntry) return;
        if (list.length >= MAX_TAB_MANAGER_SLOTS) {
          undoEntry = null;
          showFeedback(toastMessages.tabManagerFull(MAX_TAB_MANAGER_SLOTS));
          return;
        }
        (async () => {
          try {
            const restoreIdx = Math.min(undoEntry!.index, list.length);
            list.splice(restoreIdx, 0, undoEntry!.entry);
            undoEntry = null;
            await reorderTabManagerEntries(list);
            list = await listTabManagerEntries();
            activeIndex = restoreIdx;
            render();
          } catch (error) {
            failToSafeTabManagerState("Undo tab-manager remove failed", error);
          }
        })();
      } else {
        // Block all other keys from reaching the page
        event.stopPropagation();
      }
    }

    document.addEventListener("keydown", keyHandler, true);
    window.addEventListener("ht-navigation-mode-changed", onNavigationModeChanged);
    registerPanelCleanup(close);
    render();
    host.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open tab manager overlay:", err);
    dismissPanel();
  }
}
