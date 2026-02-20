// Popup script — browser action popup (toolbar icon click).
// Lists tab manager entries with add/remove/jump actions.

import browser from "webextension-polyfill";
import { escapeHtml, extractDomain } from "../../lib/shared/helpers";

document.addEventListener("DOMContentLoaded", async () => {
  const listEl = document.getElementById("tabManagerList")!;
  const addBtn = document.getElementById("addBtn") as HTMLButtonElement;

  async function loadTabManagerEntries(): Promise<void> {
    const tabManagerEntries = (await browser.runtime.sendMessage({
      type: "TAB_MANAGER_LIST",
    })) as TabManagerEntry[];
    renderList(tabManagerEntries);
  }

  function renderList(tabManagerEntries: TabManagerEntry[]): void {
    if (tabManagerEntries.length === 0) {
      listEl.innerHTML =
        '<div class="empty-state">No tabs added. Use Alt+Shift+T or click + Add.</div>';
      return;
    }

    listEl.innerHTML = tabManagerEntries
      .map(
        (item) => `
      <div class="tab-manager-item" data-tab-id="${item.tabId}" data-slot="${item.slot}">
        <span class="slot-badge">${item.slot}</span>
        <div class="item-info">
          <div class="item-title">${escapeHtml(item.title || "Untitled")}</div>
          <div class="item-url" title="${escapeHtml(item.url)}">${escapeHtml(extractDomain(item.url))}</div>
        </div>
        <button class="delete-btn" data-tab-id="${item.tabId}" title="Remove">\u00d7</button>
      </div>
    `,
      )
      .join("");

    // Jump on click
    listEl.querySelectorAll(".tab-manager-item").forEach((itemElement) => {
      itemElement.addEventListener("click", async (event) => {
        if ((event.target as HTMLElement).classList.contains("delete-btn")) return;
        const slot = parseInt((itemElement as HTMLElement).dataset.slot!);
        await browser.runtime.sendMessage({ type: "TAB_MANAGER_JUMP", slot });
        window.close();
      });
    });

    // Delete buttons
    listEl.querySelectorAll(".delete-btn").forEach((deleteButton) => {
      deleteButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        const tabId = parseInt((deleteButton as HTMLElement).dataset.tabId!);
        await browser.runtime.sendMessage({
          type: "TAB_MANAGER_REMOVE",
          tabId,
        });
        await loadTabManagerEntries();
      });
    });
  }

  addBtn.addEventListener("click", async () => {
    const result = (await browser.runtime.sendMessage({
      type: "TAB_MANAGER_ADD",
    })) as { ok: boolean; reason?: string };
    if (!result.ok) {
      addBtn.textContent = result.reason || "Error";
      addBtn.disabled = true;
      setTimeout(() => {
        addBtn.textContent = "+ Add";
        addBtn.disabled = false;
      }, 2000);
    }
    await loadTabManagerEntries();
  });

  await loadTabManagerEntries();
});
