// Session save/load views extracted from harpoon-overlay.
// Renders the save-session input and session-list views inside the harpoon panel.
// Also provides standalone session-restore overlay for browser startup.

import browser from "webextension-polyfill";
import { keyToDisplay, matchesAction, loadKeybindings } from "./keybindings";
import { createPanelHost, removePanelHost, getBaseStyles } from "./panel-host";
import { escapeHtml } from "./helpers";
import { showFeedback } from "./feedback";

/** Shared context passed from the harpoon overlay to session views */
export interface SessionContext {
  shadow: ShadowRoot;
  container: HTMLElement;
  config: KeybindingsConfig;
  sessions: HarpoonSession[];
  sessionIndex: number;
  pendingSaveName: string;
  setSessionIndex(i: number): void;
  setSessions(s: HarpoonSession[]): void;
  setPendingSaveName(name: string): void;
  setViewMode(mode: "harpoon" | "saveSession" | "sessionList" | "replaceSession"): void;
  render(): void;
  close(): void;
}

// -- Save session view --

export async function renderSaveSession(ctx: SessionContext): Promise<void> {
  const { shadow, container } = ctx;

  // Fetch current sessions to show count
  const currentSessions = (await browser.runtime.sendMessage({
    type: "SESSION_LIST",
  })) as HarpoonSession[];
  const count = currentSessions.length;

  let html = `<div class="ht-backdrop"></div>
    <div class="ht-harpoon-container">
      <div class="ht-titlebar">
        <div class="ht-traffic-lights">
          <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
        </div>
        <span class="ht-titlebar-text">Save Session (${count}/3)</span>
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
    ctx.setViewMode("harpoon");
    ctx.render();
  });
  backdrop.addEventListener("mousedown", (e) => e.preventDefault());
  closeBtn.addEventListener("click", () => {
    ctx.setViewMode("harpoon");
    ctx.render();
  });

  input.focus();
}

// -- Session list view --

export function renderSessionList(ctx: SessionContext): void {
  const { shadow, container, config, sessions, sessionIndex } = ctx;

  let html = `<div class="ht-backdrop"></div>
    <div class="ht-harpoon-container">
      <div class="ht-titlebar">
        <div class="ht-traffic-lights">
          <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
        </div>
        <span class="ht-titlebar-text">Sessions</span>
      </div>
      <div class="ht-harpoon-list">`;

  if (sessions.length === 0) {
    html += `<div class="ht-session-empty">No saved sessions</div>`;
  } else {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const cls = i === sessionIndex ? "ht-session-item active" : "ht-session-item";
      const date = new Date(s.savedAt).toLocaleDateString();
      html += `<div class="${cls}" data-index="${i}">
        <div class="ht-session-name">${escapeHtml(s.name)}</div>
        <span class="ht-session-meta">${s.entries.length} tabs \u00b7 ${date}</span>
        <button class="ht-session-delete" data-index="${i}" title="Delete">\u00d7</button>
      </div>`;
    }
  }

  const moveUpKey = keyToDisplay(config.bindings.harpoon.moveUp.key);
  const moveDownKey = keyToDisplay(config.bindings.harpoon.moveDown.key);
  const removeKey = keyToDisplay(config.bindings.harpoon.remove.key);

  html += `</div><div class="ht-footer">
    <div class="ht-footer-row">
      <span>${moveUpKey}/${moveDownKey} j/k move</span>
      <span>Enter load</span>
      <span>${removeKey} del</span>
      <span>Esc back</span>
    </div>
  </div></div>`;

  container.innerHTML = html;

  const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
  const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;

  backdrop.addEventListener("click", () => {
    ctx.setViewMode("harpoon");
    ctx.render();
  });
  backdrop.addEventListener("mousedown", (e) => e.preventDefault());
  closeBtn.addEventListener("click", () => {
    ctx.setViewMode("harpoon");
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

  // Click × to delete
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
    <div class="ht-harpoon-container">
      <div class="ht-titlebar">
        <div class="ht-traffic-lights">
          <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
        </div>
        <span class="ht-titlebar-text">Replace which session?</span>
      </div>
      <div class="ht-harpoon-list">`;

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
      <span>\u2191/\u2193 move</span>
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
  ctx.setViewMode("harpoon");
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
  if (matchesAction(e, ctx.config, "harpoon", "moveDown")) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions.length > 0) {
      ctx.setSessionIndex(Math.min(ctx.sessionIndex + 1, ctx.sessions.length - 1));
      ctx.render();
    }
    return true;
  }
  if (matchesAction(e, ctx.config, "harpoon", "moveUp")) {
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
    ctx.setViewMode("harpoon");
    ctx.render();
  } else if (result.reason && result.reason.includes("Max 3")) {
    // At capacity — prompt user to pick a session to replace
    ctx.setPendingSaveName(name.trim());
    const sessions = (await browser.runtime.sendMessage({
      type: "SESSION_LIST",
    })) as HarpoonSession[];
    ctx.setSessions(sessions);
    ctx.setSessionIndex(0);
    ctx.setViewMode("replaceSession");
    ctx.render();
  } else {
    showFeedback(result.reason || "Failed to save session");
    ctx.setViewMode("harpoon");
    ctx.render();
  }
}

export async function loadSession(ctx: SessionContext, session: HarpoonSession): Promise<void> {
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
  })) as HarpoonSession[];
  ctx.setSessions(sessions);
  ctx.setSessionIndex(Math.min(ctx.sessionIndex, Math.max(sessions.length - 1, 0)));
  ctx.render();
}

// -- Session keyboard handlers --

/** Validate session save: check for duplicate name and identical content */
async function validateSessionSave(name: string): Promise<string | null> {
  const [harpoonList, sessions] = await Promise.all([
    browser.runtime.sendMessage({ type: "HARPOON_LIST" }) as Promise<HarpoonEntry[]>,
    browser.runtime.sendMessage({ type: "SESSION_LIST" }) as Promise<HarpoonSession[]>,
  ]);
  // Check identical content first (more specific error)
  const currentUrls = harpoonList.map((e) => e.url).join("\n");
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
    ctx.setViewMode("harpoon");
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
  if (matchesAction(e, ctx.config, "harpoon", "close") || e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    ctx.setViewMode("harpoon");
    ctx.render();
    return true;
  }
  if (matchesAction(e, ctx.config, "harpoon", "moveDown")) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions.length > 0) {
      ctx.setSessionIndex(Math.min(ctx.sessionIndex + 1, ctx.sessions.length - 1));
      ctx.render();
    }
    return true;
  }
  if (matchesAction(e, ctx.config, "harpoon", "moveUp")) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions.length > 0) {
      ctx.setSessionIndex(Math.max(ctx.sessionIndex - 1, 0));
      ctx.render();
    }
    return true;
  }
  if (matchesAction(e, ctx.config, "harpoon", "jump")) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions[ctx.sessionIndex]) loadSession(ctx, ctx.sessions[ctx.sessionIndex]);
    return true;
  }
  if (matchesAction(e, ctx.config, "harpoon", "remove")) {
    e.preventDefault();
    e.stopPropagation();
    if (ctx.sessions[ctx.sessionIndex]) deleteSession(ctx, ctx.sessionIndex);
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
    })) as HarpoonSession[];
    if (sessions.length === 0) return;

    const config = await loadKeybindings();
    const { host, shadow } = createPanelHost();

    const style = document.createElement("style");
    style.textContent =
      getBaseStyles() +
      `
      .ht-restore-container {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        width: 380px; background: #1e1e1e; border: 1px solid rgba(255,255,255,0.1);
        border-radius: 10px; overflow: hidden;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
        display: flex; flex-direction: column;
      }
      .ht-restore-list { max-height: 260px; overflow-y: auto; }
      .ht-restore-item {
        display: flex; align-items: center; padding: 8px 14px; gap: 10px;
        cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.04);
        transition: background 0.1s; user-select: none;
      }
      .ht-restore-item:hover { background: rgba(255,255,255,0.06); }
      .ht-restore-item.active {
        background: rgba(10,132,255,0.15); border-left: 2px solid #0a84ff;
      }
      .ht-restore-name {
        flex: 1; font-size: 12px; color: #e0e0e0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ht-restore-meta {
        font-size: 10px; color: #808080; flex-shrink: 0;
      }
      .ht-restore-empty {
        padding: 24px; text-align: center; color: #808080; font-size: 12px;
      }
    `;
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
        <div class="ht-restore-container">
          <div class="ht-titlebar">
            <div class="ht-traffic-lights">
              <button class="ht-dot ht-dot-close" title="Decline (Esc)"></button>
            </div>
            <span class="ht-titlebar-text">Restore Session?</span>
          </div>
          <div class="ht-restore-list">`;

      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const cls = i === activeIndex ? "ht-restore-item active" : "ht-restore-item";
        const date = new Date(s.savedAt).toLocaleDateString();
        html += `<div class="${cls}" data-index="${i}">
          <div class="ht-restore-name">${escapeHtml(s.name)}</div>
          <span class="ht-restore-meta">${s.entries.length} tabs \u00b7 ${date}</span>
        </div>`;
      }

      html += `</div>
        <div class="ht-footer">
          <div class="ht-footer-row">
      <span>\u2191/\u2193 j/k move</span>
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

      shadow.querySelectorAll(".ht-restore-item").forEach((el) => {
        el.addEventListener("click", () => {
          const idx = parseInt((el as HTMLElement).dataset.index!);
          restoreSession(sessions[idx]);
        });
      });

      const activeEl = shadow.querySelector(".ht-restore-item.active");
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    }

    async function restoreSession(session: HarpoonSession): Promise<void> {
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
      if (matchesAction(e, config, "harpoon", "moveDown")) {
        e.preventDefault();
        e.stopPropagation();
        activeIndex = Math.min(activeIndex + 1, sessions.length - 1);
        render();
        return;
      }
      if (matchesAction(e, config, "harpoon", "moveUp")) {
        e.preventDefault();
        e.stopPropagation();
        activeIndex = Math.max(activeIndex - 1, 0);
        render();
        return;
      }
      e.stopPropagation();
    }

    document.addEventListener("keydown", keyHandler, true);
    render();
    host.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open session restore overlay:", err);
  }
}
