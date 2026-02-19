// Add Bookmark overlay — triggered by Alt+Shift+B or `a` inside the bookmark overlay.
// Three-step state machine:
//   1. chooseType  — pick File, Folder, or Folder + File
//   2. chooseDest  — pick destination folder (or root)
//   3. nameInput   — (folder/folderAndFile) enter a name for the new folder

import browser from "webextension-polyfill";
import { createPanelHost, removePanelHost, registerPanelCleanup, getBaseStyles, vimBadgeHtml } from "../shared/panelHost";
import { escapeHtml } from "../shared/helpers";
import { showFeedback } from "../shared/feedback";
import addBookmarkStyles from "./addBookmark.css";

// Folder tree node returned from background
interface BookmarkFolder {
  id: string;
  title: string;
  depth: number;
  children: BookmarkFolder[];
}

/** Flatten a folder tree into a depth-first list for rendering */
function flattenFolders(folders: BookmarkFolder[]): { id: string; title: string; depth: number }[] {
  const flat: { id: string; title: string; depth: number }[] = [];
  function walk(nodes: BookmarkFolder[]): void {
    for (const f of nodes) {
      flat.push({ id: f.id, title: f.title, depth: f.depth });
      if (f.children.length > 0) walk(f.children);
    }
  }
  walk(folders);
  return flat;
}

export async function openAddBookmarkOverlay(
  config: KeybindingsConfig,
): Promise<void> {
  try {
    const { host, shadow } = createPanelHost();

    const style = document.createElement("style");
    style.textContent = getBaseStyles() + addBookmarkStyles;
    shadow.appendChild(style);

    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "ht-backdrop";
    shadow.appendChild(backdrop);

    // Container
    const panel = document.createElement("div");
    panel.className = "ht-addbm-container";
    shadow.appendChild(panel);

    // Title bar
    const titlebar = document.createElement("div");
    titlebar.className = "ht-titlebar";
    titlebar.innerHTML = `
      <div class="ht-traffic-lights">
        <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
      </div>
      <span class="ht-titlebar-text">Add Bookmark</span>
      ${vimBadgeHtml(config)}`;
    panel.appendChild(titlebar);

    // Body (swapped per step)
    const body = document.createElement("div");
    body.style.cssText = "display:flex;flex-direction:column;flex:1;overflow:hidden;";
    panel.appendChild(body);

    // Footer
    const footer = document.createElement("div");
    footer.className = "ht-footer";
    panel.appendChild(footer);

    const titleText = titlebar.querySelector(".ht-titlebar-text") as HTMLElement;

    // --- State ---
    type Step = "chooseType" | "chooseDest" | "nameInput";
    let step: Step = "chooseType";
    let chosenType: "file" | "folder" | "folderAndFile" = "file";
    let activeIndex = 0;
    let flatFolders: { id: string; title: string; depth: number }[] = [];
    let nameInputEl: HTMLInputElement | null = null;
    let errorEl: HTMLElement | null = null;

    function close(): void {
      document.removeEventListener("keydown", keyHandler, true);
      removePanelHost();
    }

    // --- Step 1: Choose type (File, Folder, or Folder + File) ---
    function renderChooseType(): void {
      titleText.textContent = "Add Bookmark";
      activeIndex = 0;

      body.innerHTML = `<div class="ht-addbm-list">
        <div class="ht-addbm-item active" data-idx="0">
          <span class="ht-addbm-icon">\u{1F4C4}</span>
          <div>
            <div class="ht-addbm-name">Create a Bookmark</div>
            <div class="ht-addbm-desc">Save current page as a bookmark</div>
          </div>
        </div>
        <div class="ht-addbm-item" data-idx="1">
          <span class="ht-addbm-icon">\u{1F4C1}</span>
          <div>
            <div class="ht-addbm-name">Create a New Folder</div>
            <div class="ht-addbm-desc">Create an empty folder</div>
          </div>
        </div>
        <div class="ht-addbm-item" data-idx="2">
          <span class="ht-addbm-icon">\u{1F4C2}</span>
          <div>
            <div class="ht-addbm-name">Bookmark into New Folder</div>
            <div class="ht-addbm-desc">Create a folder and save current page in it</div>
          </div>
        </div>
      </div>`;

      footer.innerHTML = `<div class="ht-footer-row">
        <span>j/k (vim) \u2191/\u2193 nav</span>
         <span>Enter select</span>
         <span>Esc cancel</span>
      </div>`;

      // Click handler
      const list = body.querySelector(".ht-addbm-list") as HTMLElement;
      list.addEventListener("click", (e) => {
        const item = (e.target as HTMLElement).closest("[data-idx]") as HTMLElement;
        if (!item) return;
        const idx = parseInt(item.dataset.idx!);
        chosenType = idx === 0 ? "file" : idx === 1 ? "folder" : "folderAndFile";
        transitionToChooseDest();
      });
    }

    // --- Step 2: Choose destination folder ---
    async function transitionToChooseDest(): Promise<void> {
      step = "chooseDest";
      activeIndex = 0;

      const label = chosenType === "file" ? "save bookmark" : "create folder";
      titleText.textContent = `Choose where to ${label}`;

      // Fetch folders
      const folders = (await browser.runtime.sendMessage({
        type: "BOOKMARK_FOLDERS",
      })) as BookmarkFolder[];
      flatFolders = flattenFolders(folders);

      renderChooseDest();
    }

    function renderChooseDest(): void {
      let html = `<div class="ht-addbm-list">
        <div class="ht-addbm-none${activeIndex === 0 ? " active" : ""}" data-idx="0">
          \u2014 Root (no folder)
        </div>`;

      for (let i = 0; i < flatFolders.length; i++) {
        const f = flatFolders[i];
        const indent = f.depth > 0 ? `padding-left:${14 + f.depth * 16}px;` : "";
        html += `<div class="ht-addbm-item${activeIndex === i + 1 ? " active" : ""}" data-idx="${i + 1}" style="${indent}">
          <span class="ht-addbm-icon">\u{1F4C1}</span>
          <span class="ht-addbm-name">${escapeHtml(f.title)}</span>
        </div>`;
      }

      html += `</div>`;
      body.innerHTML = html;

      footer.innerHTML = `<div class="ht-footer-row">
        <span>j/k (vim) \u2191/\u2193 nav</span>
         <span>Enter select</span>
         <span>Esc back</span>
      </div>`;

      // Click handler
      const list = body.querySelector(".ht-addbm-list") as HTMLElement;
      list.addEventListener("click", (e) => {
        const item = (e.target as HTMLElement).closest("[data-idx]") as HTMLElement;
        if (!item) return;
        const idx = parseInt(item.dataset.idx!);
        confirmDest(idx);
      });
    }

    function getParentId(idx: number): string | undefined {
      return idx === 0 ? undefined : flatFolders[idx - 1]?.id;
    }

    function getParentLabel(idx: number): string {
      return idx === 0 ? "" : ` in ${flatFolders[idx - 1]?.title || "folder"}`;
    }

    async function confirmDest(idx: number): Promise<void> {
      if (chosenType === "file") {
        // Save bookmark directly
        const parentId = getParentId(idx);
        const msg: Record<string, unknown> = { type: "BOOKMARK_ADD" };
        if (parentId) msg.parentId = parentId;

        const result = (await browser.runtime.sendMessage(msg)) as {
          ok: boolean;
          title?: string;
        };

        if (result.ok) {
          showFeedback(`Bookmarked: ${result.title || "current page"}${getParentLabel(idx)}`);
        } else {
          showFeedback("Failed to add bookmark");
        }
        close();
      } else {
        // Both folder and folderAndFile go to name input
        transitionToNameInput(idx);
      }
    }

    // --- Step 3: Folder name input ---
    function transitionToNameInput(destIdx: number): void {
      step = "nameInput";
      const destLabel = destIdx === 0 ? "root" : flatFolders[destIdx - 1]?.title || "folder";
      titleText.textContent = `New folder in ${destLabel}`;

      body.innerHTML = `
        <div class="ht-addbm-input-wrap">
          <span class="ht-addbm-prompt">Name:</span>
          <input type="text" class="ht-addbm-input"
                 placeholder="e.g. Work, Research, Recipes..." maxlength="60" />
        </div>
        <div class="ht-addbm-error"></div>`;

      footer.innerHTML = `<div class="ht-footer-row">
        <span>Enter create</span>
        <span>Esc back</span>
      </div>`;

      nameInputEl = body.querySelector(".ht-addbm-input") as HTMLInputElement;
      errorEl = body.querySelector(".ht-addbm-error") as HTMLElement;
      nameInputEl.focus();

      // Store destIdx for confirm
      nameInputEl.dataset.destIdx = String(destIdx);
    }

    function showError(msg: string): void {
      if (!errorEl) return;
      errorEl.textContent = msg;
      errorEl.style.display = "";
      if (nameInputEl) nameInputEl.style.borderBottom = "1px solid #ff5f57";
      setTimeout(() => {
        if (errorEl) errorEl.style.display = "none";
        if (nameInputEl) nameInputEl.style.borderBottom = "";
      }, 2000);
    }

    async function confirmFolderCreate(): Promise<void> {
      if (!nameInputEl) return;
      const name = nameInputEl.value.trim();
      if (!name) {
        showError("A folder name is required");
        return;
      }
      const destIdx = parseInt(nameInputEl.dataset.destIdx || "0");
      const parentId = getParentId(destIdx);

      const msg: Record<string, unknown> = {
        type: "BOOKMARK_CREATE_FOLDER",
        title: name,
      };
      if (parentId) msg.parentId = parentId;

      const result = (await browser.runtime.sendMessage(msg)) as {
        ok: boolean;
        id?: string;
        title?: string;
        reason?: string;
      };

      if (!result.ok) {
        showFeedback(result.reason || "Failed to create folder");
        close();
        return;
      }

      if (chosenType === "folderAndFile" && result.id) {
        // Also bookmark current page into the new folder
        const addResult = (await browser.runtime.sendMessage({
          type: "BOOKMARK_ADD",
          parentId: result.id,
        })) as { ok: boolean; title?: string };

        if (addResult.ok) {
          showFeedback(`Created folder "${name}" and bookmarked: ${addResult.title || "current page"}`);
        } else {
          showFeedback(`Created folder "${name}" but failed to add bookmark`);
        }
      } else {
        showFeedback(`Created folder: ${name}${getParentLabel(destIdx)}`);
      }
      close();
    }

    // --- Shared highlight update ---
    function updateHighlight(newIndex: number, totalItems: number): void {
      if (newIndex < 0 || newIndex >= totalItems) return;
      const items = body.querySelectorAll("[data-idx]");
      items.forEach((el) => el.classList.remove("active"));
      activeIndex = newIndex;
      const activeEl = items[newIndex] as HTMLElement;
      if (activeEl) {
        activeEl.classList.add("active");
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }

    // --- Keyboard handler (dispatches per step) ---
    function keyHandler(e: KeyboardEvent): void {
      if (!document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      // --- nameInput step ---
      if (step === "nameInput") {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          // Go back to chooseDest
          step = "chooseDest";
          nameInputEl = null;
          errorEl = null;
          renderChooseDest();
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          confirmFolderCreate();
          return;
        }
        // Let typing flow to the input
        e.stopPropagation();
        return;
      }

      // --- chooseType / chooseDest steps ---
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (step === "chooseDest") {
          // Go back to chooseType
          step = "chooseType";
          activeIndex = 0;
          renderChooseType();
        } else {
          close();
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (step === "chooseType") {
          chosenType = activeIndex === 0 ? "file" : activeIndex === 1 ? "folder" : "folderAndFile";
          transitionToChooseDest();
        } else if (step === "chooseDest") {
          confirmDest(activeIndex);
        }
        return;
      }

      const totalItems = step === "chooseType" ? 3 : flatFolders.length + 1;
      const vim = config.navigationMode === "vim";

      if (e.key === "ArrowDown" || (vim && e.key === "j")) {
        e.preventDefault();
        e.stopPropagation();
        updateHighlight(Math.min(activeIndex + 1, totalItems - 1), totalItems);
        return;
      }

      if (e.key === "ArrowUp" || (vim && e.key === "k")) {
        e.preventDefault();
        e.stopPropagation();
        updateHighlight(Math.max(activeIndex - 1, 0), totalItems);
        return;
      }

      e.stopPropagation();
    }

    // Event binding
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (e) => e.preventDefault());
    titlebar.querySelector(".ht-dot-close")!.addEventListener("click", close);

    document.addEventListener("keydown", keyHandler, true);
    registerPanelCleanup(close);

    // Start at step 1
    renderChooseType();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open add-bookmark overlay:", err);
  }
}
