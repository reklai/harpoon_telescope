// Session save/load views for the tab manager overlay.
// Renders the save-session input and session-list views inside the tab manager panel.
// Also provides standalone session-restore overlay for browser startup.

import browser from "webextension-polyfill";
import { keyToDisplay, matchesAction, loadKeybindings, MAX_SESSIONS } from "../shared/keybindings";
import { createPanelHost, removePanelHost, registerPanelCleanup, getBaseStyles } from "../shared/panelHost";
import { escapeHtml } from "../shared/helpers";
import { showFeedback } from "../shared/feedback";
import restoreStyles from "./session.css";

// Rename mode — when true, the active session item shows an inline input
let isRenameModeActive = false;

// Overwrite confirmation — when true, titlebar shows y/n prompt
let isOverwriteConfirmationActive = false;

/** Shared context passed from the tab manager overlay to session views */
export interface SessionContext {
  shadow: ShadowRoot;
  container: HTMLElement;
  config: KeybindingsConfig;
  sessions: TabManagerSession[];
  sessionIndex: number;
  pendingSaveName: string;
  setSessionIndex(i: number): void;
  setSessions(s: TabManagerSession[]): void;
  setPendingSaveName(name: string): void;
  setViewMode(mode: "tabManager" | "saveSession" | "sessionList" | "replaceSession"): void;
  render(): void;
  close(): void;
}

// -- Save session view --

export async function renderSaveSession(ctx: SessionContext): Promise<void> {
  const { shadow, container } = ctx;

  // Fetch current sessions to show count
  const currentSessions = (await browser.runtime.sendMessage({
    type: "SESSION_LIST",
  })) as TabManagerSession[];
  const count = currentSessions.length;

  let html = `<div class="ht-backdrop"></div>
    <div class="ht-tab-manager-container">
      <div class="ht-titlebar">
        <div class="ht-traffic-lights">
          <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
        </div>
        <span class="ht-titlebar-text">Save Session (${count}/${MAX_SESSIONS})</span>
      </div>
      <div class="ht-session-input-wrap">
        <span class="ht-session-prompt">Name:</span>
        <input type="text" class="ht-session-input" placeholder="e.g. Research, Debug, Feature..." maxlength="30" />
      </div>
      <div class="ht-session-error" style="display:none; padding: 4px 14px; font-size: 10px; color: #ff5f57;"></div>
      <div class="ht-footer">
        <div class="ht-footer-row">
          <span>Enter save</span>
          <span>Esc back</span>
        </div>
      </div>
    </div>`;

  container.innerHTML = html;

  const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
  const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;
  const input = shadow.querySelector(".ht-session-input") as HTMLInputElement;

  backdrop.addEventListener("click", () => {
    ctx.setViewMode("tabManager");
    ctx.render();
  });
  backdrop.addEventListener("mousedown", (e) => e.preventDefault());
  closeBtn.addEventListener("click", () => {
    ctx.setViewMode("tabManager");
    ctx.render();
  });

  input.focus();
}

// -- Session list view --

export function renderSessionList(ctx: SessionContext): void {
  const { shadow, container, config, sessions, sessionIndex } = ctx;

  const titleText = isOverwriteConfirmationActive && sessions[sessionIndex]
    ? `Overwrite "${escapeHtml(sessions[sessionIndex].name)}"? y / n`
    : "Sessions";

  let html = `<div class="ht-backdrop"></div>
    <div class="ht-tab-manager-container">
      <div class="ht-titlebar">
        <div class="ht-traffic-lights">
          <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
        </div>
        <span class="ht-titlebar-text">${titleText}</span>
      </div>
      <div class="ht-tab-manager-list">`;

  if (sessions.length === 0) {
    html += `<div class="ht-session-empty">No saved sessions</div>`;
  } else {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const cls = i === sessionIndex ? "ht-session-item active" : "ht-session-item";
      const date = new Date(s.savedAt).toLocaleDateString();
      const nameContent = isRenameModeActive && i === sessionIndex
        ? `<input type="text" class="ht-session-rename-input" value="${escapeHtml(s.name)}" maxlength="30" />`
        : `<div class="ht-session-name">${escapeHtml(s.name)}</div>`;
      html += `<div class="${cls}" data-index="${i}">
        ${nameContent}
        <span class="ht-session-meta">${s.entries.length} tabs \u00b7 ${date}</span>
        <button class="ht-session-delete" data-index="${i}" title="Delete">\u00d7</button>
      </div>`;
    }
  }

  const moveUpKey = keyToDisplay(config.bindings.tabManager.moveUp.key);
  const moveDownKey = keyToDisplay(config.bindings.tabManager.moveDown.key);
  const removeKey = keyToDisplay(config.bindings.tabManager.remove.key);

  html += `</div><div class="ht-footer">
    <div class="ht-footer-row">
      <span>j/k (vim) ${moveUpKey}/${moveDownKey} nav</span>
      <span>R rename</span>
      <span>O overwrite</span>
      <span>${removeKey} del</span>
    </div>
    <div class="ht-footer-row">
      <span>Enter load</span>
      <span>Esc back</span>
    </div>
  </div></div>`;

  container.innerHTML = html;

  const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
  const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;

  backdrop.addEventListener("click", () => {
    ctx.setViewMode("tabManager");
    ctx.render();
  });
  backdrop.addEventListener("mousedown", (e) => e.preventDefault());
  closeBtn.addEventListener("click", () => {
    ctx.setViewMode("tabManager");
    ctx.render();
  });

  // Click to load (skip if clicking delete button)
  shadow.querySelectorAll(".ht-session-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".ht-session-delete")) return;
      const idx = parseInt((el as HTMLElement).dataset.index!);
      loadSession(ctx, sessions[idx]);
    });
  });

  // Click x to delete
  shadow.querySelectorAll(".ht-session-delete").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt((el as HTMLElement).dataset.index!);
      deleteSession(ctx, idx);
    });
  });

  const activeEl = shadow.querySelector(".ht-session-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

// -- Replace session picker view --

export function renderReplaceSession(ctx: SessionContext): void {
  const { shadow, container, sessions, sessionIndex } = ctx;

  let html = `<div class="ht-backdrop"></div>
    <div class="ht-tab-manager-container">
      <div class="ht-titlebar">
        <div class="ht-traffic-lights">
          <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
        </div>
        <span class="ht-titlebar-text">Replace which session?</span>
      </div>
      <div class="ht-tab-manager-list">`;

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const cls = i === sessionIndex ? "ht-session-item active" : "ht-session-item";
    const date = new Date(s.savedAt).toLocaleDateString();
    html += `<div class="${cls}" data-index="${i}">
      <div class="ht-session-name">${escapeHtml(s.name)}</div>
      <span class="ht-session-meta">${s.entries.length} tabs \u00b7 ${date}</span>
    </div>`;
  }

  html += `</div><div class="ht-footer">
    <div class="ht-footer-row">
      <span>\u2191/\u2193 nav</span>
       <span>Enter replace</span>
      <span>Esc back</span>
    </div>
  </div></div>`;

  container.innerHTML = html;

  const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
  const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;

  backdrop.addEventListener("click", () => {
    ctx.setViewMode("saveSession");
    ctx.render();
  });
  backdrop.addEventListener("mousedown", (e) => e.preventDefault());
  closeBtn.addEventListener("click", () => {
    ctx.setViewMode("saveSession");
    ctx.render();
  });

  // Click to replace
  shadow.querySelectorAll(".ht-session-item").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt((el as HTMLElement).dataset.index!);
      replaceSession(ctx, idx);
    });
  });

  const activeEl = shadow.querySelector(".ht-session-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

async function replaceSession(ctx: SessionContext, idx: number): Promise<void> {
  const oldName = ctx.sessions[idx].name;
  // Delete the old session, then save new one with the pending name
  await browser.runtime.sendMessage({ type: "SESSION_DELETE", name: oldName });
  const result = (await browser.runtime.sendMessage({
    type: "SESSION_SAVE",
    name: ctx.pendingSaveName,
  })) as { ok: boolean; reason?: string };
  if (result.ok) {
    showFeedback(`Session "${ctx.pendingSaveName}" saved (replaced "${oldName}")`);
  } else {
    showFeedback(result.reason || "Failed to save session");
  }
  ctx.setViewMode("tabManager");
  ctx.render();
}

/** Handle keydown events in replaceSession view. Returns true if handled. */
export function handleReplaceSessionKey(ctx: SessionContext, e: KeyboardEvent): boolean {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    ctx.setViewMode("saveSession");
    ctx.render();
    return true;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions[ctx.sessionIndex]) replaceSession(ctx, ctx.sessionIndex);
    return true;
  }
  if (matchesAction(e, ctx.config, "tabManager", "moveDown")) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions.length > 0) {
      ctx.setSessionIndex(Math.min(ctx.sessionIndex + 1, ctx.sessions.length - 1));
      ctx.render();
    }
    return true;
  }
  if (matchesAction(e, ctx.config, "tabManager", "moveUp")) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions.length > 0) {
      ctx.setSessionIndex(Math.max(ctx.sessionIndex - 1, 0));
      ctx.render();
    }
    return true;
  }
  e.stopPropagation();
  return true;
}

export async function saveSession(ctx: SessionContext, name: string): Promise<void> {
  if (!name.trim()) return;
  const result = (await browser.runtime.sendMessage({
    type: "SESSION_SAVE",
    name: name.trim(),
  })) as { ok: boolean; reason?: string };
  if (result.ok) {
    showFeedback(`Session "${name.trim()}" saved`);
    ctx.setViewMode("tabManager");
    ctx.render();
  } else if (result.reason && result.reason.includes(`Max ${MAX_SESSIONS}`)) {
    // At capacity — prompt user to pick a session to replace
    ctx.setPendingSaveName(name.trim());
    const sessions = (await browser.runtime.sendMessage({
      type: "SESSION_LIST",
    })) as TabManagerSession[];
    ctx.setSessions(sessions);
    ctx.setSessionIndex(0);
    ctx.setViewMode("replaceSession");
    ctx.render();
  } else {
    showFeedback(result.reason || "Failed to save session");
    ctx.setViewMode("tabManager");
    ctx.render();
  }
}

export async function loadSession(ctx: SessionContext, session: TabManagerSession): Promise<void> {
  ctx.close();
  const result = (await browser.runtime.sendMessage({
    type: "SESSION_LOAD",
    name: session.name,
  })) as { ok: boolean; count?: number };
  if (result.ok) {
    showFeedback(`Session "${session.name}" loaded (${result.count} tabs)`);
  }
}

export async function deleteSession(ctx: SessionContext, idx: number): Promise<void> {
  const name = ctx.sessions[idx].name;
  await browser.runtime.sendMessage({
    type: "SESSION_DELETE",
    name,
  });
  const sessions = (await browser.runtime.sendMessage({
    type: "SESSION_LIST",
  })) as TabManagerSession[];
  ctx.setSessions(sessions);
  ctx.setSessionIndex(Math.min(ctx.sessionIndex, Math.max(sessions.length - 1, 0)));
  ctx.render();
}

// -- Session keyboard handlers --

/** Validate session save: check for duplicate name and identical content */
async function validateSessionSave(name: string): Promise<string | null> {
  const [tabManagerList, sessions] = await Promise.all([
    browser.runtime.sendMessage({ type: "TAB_MANAGER_LIST" }) as Promise<TabManagerEntry[]>,
    browser.runtime.sendMessage({ type: "SESSION_LIST" }) as Promise<TabManagerSession[]>,
  ]);
  // Check identical content first (more specific error)
  const currentUrls = tabManagerList.map((e) => e.url).join("\n");
  for (const s of sessions) {
    const sessionUrls = s.entries.map((e) => e.url).join("\n");
    if (currentUrls === sessionUrls) return `Identical to "${s.name}"`;
  }
  // Check duplicate name
  const trimmed = name.trim().toLowerCase();
  for (const s of sessions) {
    if (s.name.toLowerCase() === trimmed) return `"${s.name}" already exists`;
  }
  return null;
}

/** Handle keydown events in saveSession view. Returns true if handled. */
export function handleSaveSessionKey(ctx: SessionContext, e: KeyboardEvent): boolean {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    ctx.setViewMode("tabManager");
    ctx.render();
    return true;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    const input = ctx.shadow.querySelector(".ht-session-input") as HTMLInputElement;
    if (input && !input.value.trim()) {
      const errorEl = ctx.shadow.querySelector(".ht-session-error") as HTMLElement;
      if (errorEl) {
        errorEl.textContent = "A session name is required";
        errorEl.style.display = "";
        input.style.borderBottom = "1px solid #ff5f57";
        setTimeout(() => { errorEl.style.display = "none"; input.style.borderBottom = ""; }, 2000);
      }
      return true;
    }
    if (input) {
      validateSessionSave(input.value).then((err) => {
        if (err) {
          const errorEl = ctx.shadow.querySelector(".ht-session-error") as HTMLElement;
          if (errorEl) {
            errorEl.textContent = err;
            errorEl.style.display = "";
            input.style.borderBottom = "1px solid #ff5f57";
            setTimeout(() => { errorEl.style.display = "none"; input.style.borderBottom = ""; }, 2000);
          }
        } else {
          saveSession(ctx, input.value);
        }
      });
    }
    return true;
  }
  // Let typing through to the input
  e.stopPropagation();
  return true;
}

/** Handle keydown events in sessionList view. Returns true if handled. */
export function handleSessionListKey(ctx: SessionContext, e: KeyboardEvent): boolean {
  // During rename mode, only handle Enter/Escape — let all other keys through to the input
  if (isRenameModeActive) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      isRenameModeActive = false;
      ctx.render();
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const input = ctx.shadow.querySelector(".ht-session-rename-input") as HTMLInputElement;
      if (input && input.value.trim()) {
        const oldName = ctx.sessions[ctx.sessionIndex].name;
        const newName = input.value.trim();
        (async () => {
          const result = (await browser.runtime.sendMessage({
            type: "SESSION_RENAME",
            oldName,
            newName,
          })) as { ok: boolean; reason?: string };
          isRenameModeActive = false;
          if (result.ok) {
            showFeedback(`Renamed to "${newName}"`);
            const sessions = (await browser.runtime.sendMessage({
              type: "SESSION_LIST",
            })) as TabManagerSession[];
            ctx.setSessions(sessions);
          } else {
            showFeedback(result.reason || "Rename failed");
          }
          ctx.render();
        })();
      }
      return true;
    }
    // Let typing reach the input (don't preventDefault)
    e.stopPropagation();
    return true;
  }

  // During overwrite confirmation, only accept y/n/Escape
  if (isOverwriteConfirmationActive) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key.toLowerCase() === "y") {
      const session = ctx.sessions[ctx.sessionIndex];
      isOverwriteConfirmationActive = false;
      (async () => {
        const result = (await browser.runtime.sendMessage({
          type: "SESSION_UPDATE",
          name: session.name,
        })) as { ok: boolean; reason?: string };
        if (result.ok) {
          showFeedback(`Session "${session.name}" overwritten`);
          const sessions = (await browser.runtime.sendMessage({
            type: "SESSION_LIST",
          })) as TabManagerSession[];
          ctx.setSessions(sessions);
        } else {
          showFeedback(result.reason || "Overwrite failed");
        }
        ctx.render();
      })();
    } else {
      // n, Escape, or any other key cancels
      isOverwriteConfirmationActive = false;
      ctx.render();
    }
    return true;
  }

  if (matchesAction(e, ctx.config, "tabManager", "close") || e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    isRenameModeActive = false;
    isOverwriteConfirmationActive = false;
    ctx.setViewMode("tabManager");
    ctx.render();
    return true;
  }
  if (matchesAction(e, ctx.config, "tabManager", "moveDown")) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions.length > 0) {
      ctx.setSessionIndex(Math.min(ctx.sessionIndex + 1, ctx.sessions.length - 1));
      ctx.render();
    }
    return true;
  }
  if (matchesAction(e, ctx.config, "tabManager", "moveUp")) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions.length > 0) {
      ctx.setSessionIndex(Math.max(ctx.sessionIndex - 1, 0));
      ctx.render();
    }
    return true;
  }
  if (matchesAction(e, ctx.config, "tabManager", "jump")) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions[ctx.sessionIndex]) loadSession(ctx, ctx.sessions[ctx.sessionIndex]);
    return true;
  }
  if (matchesAction(e, ctx.config, "tabManager", "remove")) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions[ctx.sessionIndex]) deleteSession(ctx, ctx.sessionIndex);
    return true;
  }

  // Rename session ("r" key)
  if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions.length === 0) return true;
    isRenameModeActive = true;
    // Re-render to show inline input, then focus it
    ctx.render();
    const input = ctx.shadow.querySelector(".ht-session-rename-input") as HTMLInputElement;
    if (input) input.focus();
    return true;
  }

  // Overwrite session ("o" key) — show confirmation prompt
  if (e.key.toLowerCase() === "o" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions.length === 0) return true;
    isOverwriteConfirmationActive = true;
    ctx.render();
    return true;
  }

  e.stopPropagation();
  return true;
}

// -- Standalone session restore overlay (shown on browser startup) --

export async function openSessionRestoreOverlay(): Promise<void> {
  try {
    const sessions = (await browser.runtime.sendMessage({
      type: "SESSION_LIST",
    })) as TabManagerSession[];
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
      removePanelHost();
    }

    function render(): void {
      let html = `<div class="ht-backdrop"></div>
        <div class="ht-session-restore-container">
          <div class="ht-titlebar">
            <div class="ht-traffic-lights">
              <button class="ht-dot ht-dot-close" title="Decline (Esc)"></button>
            </div>
            <span class="ht-titlebar-text">Restore Session?</span>
          </div>
          <div class="ht-session-restore-list">`;

      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const cls = i === activeIndex ? "ht-session-restore-item active" : "ht-session-restore-item";
        const date = new Date(s.savedAt).toLocaleDateString();
        html += `<div class="${cls}" data-index="${i}">
          <div class="ht-session-restore-name">${escapeHtml(s.name)}</div>
          <span class="ht-session-restore-meta">${s.entries.length} tabs \u00b7 ${date}</span>
        </div>`;
      }

      html += `</div>
        <div class="ht-footer">
          <div class="ht-footer-row">
      <span>j/k (vim) \u2191/\u2193 nav</span>
             <span>Enter restore</span>
            <span>Esc decline</span>
          </div>
        </div>
      </div>`;

      container.innerHTML = html;

      const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
      const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;

      backdrop.addEventListener("click", close);
      backdrop.addEventListener("mousedown", (e) => e.preventDefault());
      closeBtn.addEventListener("click", close);

      shadow.querySelectorAll(".ht-session-restore-item").forEach((el) => {
        el.addEventListener("click", () => {
          const idx = parseInt((el as HTMLElement).dataset.index!);
          restoreSession(sessions[idx]);
        });
      });

      const activeEl = shadow.querySelector(".ht-session-restore-item.active");
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    }

    async function restoreSession(session: TabManagerSession): Promise<void> {
      close();
      const result = (await browser.runtime.sendMessage({
        type: "SESSION_LOAD",
        name: session.name,
      })) as { ok: boolean; count?: number };
      if (result.ok) {
        showFeedback(`Session "${session.name}" restored (${result.count} tabs)`);
      }
    }

    function keyHandler(e: KeyboardEvent): void {
      if (!document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (sessions[activeIndex]) restoreSession(sessions[activeIndex]);
        return;
      }
      if (matchesAction(e, config, "tabManager", "moveDown")) {
        e.preventDefault();
        e.stopPropagation();
        activeIndex = Math.min(activeIndex + 1, sessions.length - 1);
        render();
        return;
      }
      if (matchesAction(e, config, "tabManager", "moveUp")) {
        e.preventDefault();
        e.stopPropagation();
        activeIndex = Math.max(activeIndex - 1, 0);
        render();
        return;
      }
      e.stopPropagation();
    }

    document.addEventListener("keydown", keyHandler, true);
    registerPanelCleanup(close);
    render();
    host.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open session restore overlay:", err);
  }
}
