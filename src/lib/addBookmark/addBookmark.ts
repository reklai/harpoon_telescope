// Add Bookmark overlay — triggered by Alt+Shift+B or `a` inside the bookmark overlay.
// Four-step state machine:
//   1. chooseType   — pick File, Folder, or Folder + File
//   2. chooseDest   — pick destination folder (or root)
//   3. nameInput    — (folder/folderAndFile) enter a name for the new folder
//   4. confirmApply — confirm summary before writing

import browser from "webextension-polyfill";
import {
  createPanelHost,
  removePanelHost,
  registerPanelCleanup,
  getBaseStyles,
  vimBadgeHtml,
  dismissPanel,
} from "../shared/panelHost";
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

interface FlatBookmarkFolder {
  id: string;
  title: string;
  depth: number;
  path: string;
}

interface PendingBookmarkAction {
  kind: "file" | "folder" | "folderAndFile";
  parentId?: string;
  destIdx: number;
  destinationPath: string;
  folderName?: string;
}

/** Flatten a folder tree into a depth-first list for rendering */
function flattenFolders(folders: BookmarkFolder[]): FlatBookmarkFolder[] {
  const flat: FlatBookmarkFolder[] = [];
  function walk(nodes: BookmarkFolder[], parentPath: string): void {
    for (const folder of nodes) {
      const path = parentPath ? `${parentPath} > ${folder.title}` : folder.title;
      flat.push({ id: folder.id, title: folder.title, depth: folder.depth, path });
      if (folder.children.length > 0) walk(folder.children, path);
    }
  }
  walk(folders, "");
  return flat;
}

export async function openAddBookmarkOverlay(
  config: KeybindingsConfig,
): Promise<void> {
  try {
    const { host, shadow } = createPanelHost();
    const getNavHint = (): string => (
      config.navigationMode === "vim" ? "j/k nav · \u2191/\u2193 nav" : "\u2191/\u2193 nav"
    );

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
    type Step = "chooseType" | "chooseDest" | "nameInput" | "confirmApply";
    let step: Step = "chooseType";
    let chosenType: "file" | "folder" | "folderAndFile" = "file";
    let activeIndex = 0;
    let flatFolders: FlatBookmarkFolder[] = [];
    let nameInputEl: HTMLInputElement | null = null;
    let errorEl: HTMLElement | null = null;
    let pendingAction: PendingBookmarkAction | null = null;
    let confirmBackStep: "chooseDest" | "nameInput" = "chooseDest";
    let confirmSubmitting = false;
    const pageTitle = document.title?.trim() || "Untitled";

    function close(): void {
      document.removeEventListener("keydown", keyHandler, true);
      window.removeEventListener("ht-vim-mode-changed", onVimModeChanged);
      removePanelHost();
    }

    function updateFooterForStep(): void {
      const closeHint = "Esc cancel";
      const vimHalfPageHint = config.navigationMode === "vim"
        ? "<span>Ctrl+D/U half-page</span>"
        : "";

      if (step === "confirmApply") {
        footer.innerHTML = `<div class="ht-footer-row">
          <span>Y confirm</span>
          <span>N cancel</span>
        </div>`;
        return;
      }

      if (step === "nameInput") {
        footer.innerHTML = `<div class="ht-footer-row">
          <span>Type name</span>
        </div>
        <div class="ht-footer-row">
          <span>Enter continue</span>
          <span>Esc back</span>
        </div>`;
        return;
      }

      if (step === "chooseDest") {
        footer.innerHTML = `<div class="ht-footer-row">
          <span>${getNavHint()}</span>
          ${vimHalfPageHint}
        </div>
        <div class="ht-footer-row">
          <span>Enter select</span>
          <span>Esc back</span>
        </div>`;
        return;
      }

      footer.innerHTML = `<div class="ht-footer-row">
        <span>${getNavHint()}</span>
        ${vimHalfPageHint}
      </div>
      <div class="ht-footer-row">
        <span>Enter select</span>
        <span>${closeHint}</span>
      </div>`;
    }

    function onVimModeChanged(): void {
      updateFooterForStep();
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

      updateFooterForStep();

      // Click handler
      const list = body.querySelector(".ht-addbm-list") as HTMLElement;
      list.addEventListener("click", (event) => {
        const item = (event.target as HTMLElement).closest("[data-idx]") as HTMLElement;
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
        const folder = flatFolders[i];
        const indent = folder.depth > 0 ? `padding-left:${14 + folder.depth * 16}px;` : "";
        html += `<div class="ht-addbm-item${activeIndex === i + 1 ? " active" : ""}" data-idx="${i + 1}" style="${indent}">
          <span class="ht-addbm-icon">\u{1F4C1}</span>
          <span class="ht-addbm-name">${escapeHtml(folder.title)}</span>
        </div>`;
      }

      html += `</div>`;
      body.innerHTML = html;

      updateFooterForStep();

      // Click handler
      const list = body.querySelector(".ht-addbm-list") as HTMLElement;
      list.addEventListener("click", (event) => {
        const item = (event.target as HTMLElement).closest("[data-idx]") as HTMLElement;
        if (!item) return;
        const idx = parseInt(item.dataset.idx!);
        confirmDest(idx);
      });
    }

    function getParentId(idx: number): string | undefined {
      return idx === 0 ? undefined : flatFolders[idx - 1]?.id;
    }

    function getDestinationPath(idx: number): string {
      return idx === 0 ? "Root" : (flatFolders[idx - 1]?.path || "Root");
    }

    function getParentLabel(idx: number): string {
      return idx === 0 ? "" : ` in ${flatFolders[idx - 1]?.title || "folder"}`;
    }

    function beginConfirmAction(action: PendingBookmarkAction): void {
      pendingAction = action;
      step = "confirmApply";

      const finalPath = action.kind === "file"
        ? action.destinationPath
        : `${action.destinationPath} > ${action.folderName || "New Folder"}`;

      const confirmTitle = action.kind === "folder"
        ? (action.folderName || "New Folder")
        : pageTitle;
      const confirmIcon = action.kind === "folder" ? "\u{1F4C1}" : "\u{1F516}";

      titleText.textContent = "Confirm Bookmark Action";
      body.innerHTML = `<div class="ht-bm-confirm">
        <div class="ht-bm-confirm-icon">${confirmIcon}</div>
        <div class="ht-bm-confirm-msg">
          <span class="ht-bm-confirm-title">${escapeHtml(confirmTitle)}</span>
          <div class="ht-bm-confirm-path">Destination path > ${escapeHtml(finalPath)}</div>
        </div>
      </div>`;
      updateFooterForStep();
    }

    async function executeConfirmedAction(): Promise<void> {
      if (!pendingAction || confirmSubmitting) return;
      confirmSubmitting = true;
      const action = pendingAction;

      try {
        if (action.kind === "file") {
          const bookmarkAddRequest: Record<string, unknown> = { type: "BOOKMARK_ADD" };
          if (action.parentId) bookmarkAddRequest.parentId = action.parentId;

          const result = (await browser.runtime.sendMessage(bookmarkAddRequest)) as {
            ok: boolean;
            title?: string;
          };

          if (result.ok) {
            showFeedback(`Bookmarked: ${result.title || "current page"}${getParentLabel(action.destIdx)}`);
          } else {
            showFeedback("Failed to add bookmark");
          }
          close();
          return;
        }

        const folderName = action.folderName || "";
        const createFolderRequest: Record<string, unknown> = {
          type: "BOOKMARK_CREATE_FOLDER",
          title: folderName,
        };
        if (action.parentId) createFolderRequest.parentId = action.parentId;

        const result = (await browser.runtime.sendMessage(createFolderRequest)) as {
          ok: boolean;
          id?: string;
          reason?: string;
        };

        if (!result.ok) {
          showFeedback(result.reason || "Failed to create folder");
          close();
          return;
        }

        if (action.kind === "folderAndFile" && result.id) {
          const addResult = (await browser.runtime.sendMessage({
            type: "BOOKMARK_ADD",
            parentId: result.id,
          })) as { ok: boolean; title?: string };

          if (addResult.ok) {
            showFeedback(`Created folder "${folderName}" and bookmarked: ${addResult.title || "current page"}`);
          } else {
            showFeedback(`Created folder "${folderName}" but failed to add bookmark`);
          }
        } else {
          showFeedback(`Created folder: ${folderName}${getParentLabel(action.destIdx)}`);
        }
        close();
      } finally {
        confirmSubmitting = false;
      }
    }

    async function confirmDest(idx: number): Promise<void> {
      if (chosenType === "file") {
        confirmBackStep = "chooseDest";
        beginConfirmAction({
          kind: "file",
          parentId: getParentId(idx),
          destIdx: idx,
          destinationPath: getDestinationPath(idx),
        });
      } else {
        // Both folder and folderAndFile go to name input
        transitionToNameInput(idx);
      }
    }

    // --- Step 3: Folder name input ---
    function transitionToNameInput(destIdx: number, initialName: string = ""): void {
      step = "nameInput";
      const destLabel = destIdx === 0 ? "root" : flatFolders[destIdx - 1]?.title || "folder";
      titleText.textContent = `New folder in ${destLabel}`;

      body.innerHTML = `
        <div class="ht-addbm-input-wrap ht-ui-input-wrap">
          <span class="ht-addbm-prompt ht-ui-input-prompt">Name:</span>
          <input type="text" class="ht-addbm-input ht-ui-input-field"
                 placeholder="e.g. Work, Research, Recipes..." maxlength="60" value="${escapeHtml(initialName)}" />
        </div>
        <div class="ht-addbm-error"></div>`;

      updateFooterForStep();

      nameInputEl = body.querySelector(".ht-addbm-input") as HTMLInputElement;
      errorEl = body.querySelector(".ht-addbm-error") as HTMLElement;
      nameInputEl.focus();

      // Store destIdx for confirm
      nameInputEl.dataset.destIdx = String(destIdx);
    }

    function showError(message: string): void {
      if (!errorEl) return;
      errorEl.textContent = message;
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
      confirmBackStep = "nameInput";
      beginConfirmAction({
        kind: chosenType === "folderAndFile" ? "folderAndFile" : "folder",
        parentId: getParentId(destIdx),
        destIdx,
        destinationPath: getDestinationPath(destIdx),
        folderName: name,
      });
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

    function getListHalfPageStep(): number {
      const listEl = body.querySelector(".ht-addbm-list") as HTMLElement | null;
      const itemEl = body.querySelector("[data-idx]") as HTMLElement | null;
      const itemHeight = Math.max(1, itemEl?.offsetHeight ?? 34);
      const rows = Math.max(1, Math.floor((listEl?.clientHeight ?? (itemHeight * 8)) / itemHeight));
      return Math.max(1, Math.floor(rows / 2));
    }

    // --- Keyboard handler (dispatches per step) ---
    function keyHandler(event: KeyboardEvent): void {
      if (!document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      const vimNav = config.navigationMode === "vim";

      if (step === "confirmApply") {
        const key = event.key.toLowerCase();
        if (key === "y") {
          event.preventDefault();
          event.stopPropagation();
          void executeConfirmedAction();
          return;
        }
        if (key === "n") {
          event.preventDefault();
          event.stopPropagation();
          const action = pendingAction;
          if (!action) return;
          pendingAction = null;
          if (confirmBackStep === "chooseDest") {
            step = "chooseDest";
            activeIndex = action.destIdx;
            renderChooseDest();
          } else {
            transitionToNameInput(action.destIdx, action.folderName || "");
          }
          return;
        }
        event.stopPropagation();
        return;
      }

      // --- nameInput step ---
      if (step === "nameInput") {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          // Go back to chooseDest
          step = "chooseDest";
          nameInputEl = null;
          errorEl = null;
          renderChooseDest();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          confirmFolderCreate();
          return;
        }
        // Let typing flow to the input
        event.stopPropagation();
        return;
      }

      // --- chooseType / chooseDest steps ---
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
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

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
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

      if (
        vimNav
        && event.ctrlKey
        && !event.altKey
        && !event.metaKey
      ) {
        const lowerKey = event.key.toLowerCase();
        if (lowerKey === "d" || lowerKey === "u") {
          event.preventDefault();
          event.stopPropagation();
          const jump = getListHalfPageStep();
          const next = lowerKey === "d"
            ? Math.min(activeIndex + jump, totalItems - 1)
            : Math.max(activeIndex - jump, 0);
          updateHighlight(next, totalItems);
          return;
        }
      }

      if (event.key === "ArrowDown" || (vim && event.key === "j")) {
        event.preventDefault();
        event.stopPropagation();
        updateHighlight(Math.min(activeIndex + 1, totalItems - 1), totalItems);
        return;
      }

      if (event.key === "ArrowUp" || (vim && event.key === "k")) {
        event.preventDefault();
        event.stopPropagation();
        updateHighlight(Math.max(activeIndex - 1, 0), totalItems);
        return;
      }

      event.stopPropagation();
    }

    // Event binding
    backdrop.addEventListener("click", close);
    backdrop.addEventListener("mousedown", (event) => event.preventDefault());
    titlebar.querySelector(".ht-dot-close")!.addEventListener("click", close);

    document.addEventListener("keydown", keyHandler, true);
    window.addEventListener("ht-vim-mode-changed", onVimModeChanged);
    registerPanelCleanup(close);

    // Start at step 1
    renderChooseType();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open add-bookmark overlay:", err);
    dismissPanel();
  }
}
