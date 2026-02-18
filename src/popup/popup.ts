// Popup script — browser action popup (toolbar icon click).
// Lists harpooned tabs with add/remove/jump actions.

import browser from "webextension-polyfill";

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return url.length > 40 ? url.substring(0, 40) + "\u2026" : url;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const listEl = document.getElementById("harpoonList")!;
  const addBtn = document.getElementById("addBtn") as HTMLButtonElement;

  async function loadList(): Promise<void> {
    const list = (await browser.runtime.sendMessage({
      type: "HARPOON_LIST",
    })) as HarpoonEntry[];
    renderList(list);
  }

  function renderList(list: HarpoonEntry[]): void {
    if (list.length === 0) {
      listEl.innerHTML =
        '<div class="empty-state">No harpooned tabs. Use Alt+A or click + Add.</div>';
      return;
    }

    listEl.innerHTML = list
      .map(
        (item) => `
      <div class="harpoon-item" data-tab-id="${item.tabId}" data-slot="${item.slot}">
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
    listEl.querySelectorAll(".harpoon-item").forEach((el) => {
      el.addEventListener("click", async (e) => {
        if ((e.target as HTMLElement).classList.contains("delete-btn")) return;
        const slot = parseInt((el as HTMLElement).dataset.slot!);
        await browser.runtime.sendMessage({ type: "HARPOON_JUMP", slot });
        window.close();
      });
    });

    // Delete buttons
    listEl.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const tabId = parseInt((btn as HTMLElement).dataset.tabId!);
        await browser.runtime.sendMessage({
          type: "HARPOON_REMOVE",
          tabId,
        });
        await loadList();
      });
    });
  }

  addBtn.addEventListener("click", async () => {
    const result = (await browser.runtime.sendMessage({
      type: "HARPOON_ADD",
    })) as { ok: boolean; reason?: string };
    if (!result.ok) {
      addBtn.textContent = result.reason || "Error";
      addBtn.disabled = true;
      setTimeout(() => {
        addBtn.textContent = "+ Add";
        addBtn.disabled = false;
      }, 2000);
    }
    await loadList();
  });

  await loadList();
});
