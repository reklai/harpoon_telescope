// Browser-action popup for quick tab-manager actions.

import { escapeHtml, extractDomain } from "../../lib/common/utils/helpers";
import {
  addCurrentTabToTabManager,
  jumpToTabManagerSlot,
  listTabManagerEntries,
  removeTabManagerEntry,
} from "../../lib/adapters/runtime/tabManagerApi";

document.addEventListener("DOMContentLoaded", async () => {
  const listEl = document.getElementById("tabManagerList")!;
  const addBtn = document.getElementById("addBtn") as HTMLButtonElement;

  async function loadTabManagerEntries(): Promise<void> {
    const tabManagerEntries = await listTabManagerEntries();
    renderList(tabManagerEntries);
  }

  function renderList(tabManagerEntries: TabManagerEntry[]): void {
    if (tabManagerEntries.length === 0) {
      listEl.innerHTML =
        '<div class="empty-state">No tabs added. Use Alt+Shift+Y or click + Add.</div>';
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

    // The list is tiny (<=4), so per-row listeners are simpler than delegation.
    listEl.querySelectorAll(".tab-manager-item").forEach((itemElement) => {
      itemElement.addEventListener("click", async (event) => {
        if ((event.target as HTMLElement).classList.contains("delete-btn")) return;
        const slot = parseInt((itemElement as HTMLElement).dataset.slot!);
        await jumpToTabManagerSlot(slot);
        window.close();
      });
    });

    listEl.querySelectorAll(".delete-btn").forEach((deleteButton) => {
      deleteButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        const tabId = parseInt((deleteButton as HTMLElement).dataset.tabId!);
        await removeTabManagerEntry(tabId);
        await loadTabManagerEntries();
      });
    });
  }

  addBtn.addEventListener("click", async () => {
    const result = await addCurrentTabToTabManager();
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
