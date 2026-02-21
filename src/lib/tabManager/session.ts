// Session save/load views for the tab manager overlay.
// Renders the save-session input and session-list views inside the tab manager panel.
// Also provides standalone session-restore overlay for browser startup.

import browser from "webextension-polyfill";
import { keyToDisplay, matchesAction, loadKeybindings, MAX_SESSIONS } from "../shared/keybindings";
import {
  createPanelHost,
  removePanelHost,
  registerPanelCleanup,
  getBaseStyles,
  dismissPanel,
} from "../shared/panelHost";
import { escapeHtml, escapeRegex, extractDomain, normalizeUrlForMatch, buildFuzzyPattern } from "../shared/helpers";
import { showFeedback } from "../shared/feedback";
import restoreStyles from "./session.css";

// Rename mode — when true, the active session item shows an inline input
let isRenameModeActive = false;

// Overwrite confirmation — when true, titlebar shows y/n prompt
let isOverwriteConfirmationActive = false;

let isLoadConfirmationActive = false;
let pendingLoadSummary: SessionLoadSummary | null = null;
let pendingLoadSessionName = "";
let sessionListFocusTarget: "filter" | "list" = "filter";

export function resetSessionTransientState(): void {
  isRenameModeActive = false;
  isOverwriteConfirmationActive = false;
  isLoadConfirmationActive = false;
  pendingLoadSummary = null;
  pendingLoadSessionName = "";
  sessionListFocusTarget = "filter";
}

function reportSessionError(context: string, feedbackMessage: string, error: unknown): void {
  console.error(`[Harpoon Telescope] ${context}:`, error);
  showFeedback(feedbackMessage);
}

/** Shared context passed from the tab manager overlay to session views */
export interface SessionContext {
  shadow: ShadowRoot;
  container: HTMLElement;
  config: KeybindingsConfig;
  sessions: TabManagerSession[];
  sessionIndex: number;
  pendingSaveName: string;
  sessionFilterQuery: string;
  setSessionIndex(i: number): void;
  setSessions(s: TabManagerSession[]): void;
  setPendingSaveName(name: string): void;
  setSessionFilterQuery(query: string): void;
  setViewMode(mode: "tabManager" | "saveSession" | "sessionList" | "replaceSession"): void;
  render(): void;
  close(): void;
}

function scoreSessionMatch(
  lowerText: string,
  rawText: string,
  queryLower: string,
  fuzzyRe: RegExp,
): number {
  if (lowerText === queryLower) return 0;          // exact match
  if (lowerText.startsWith(queryLower)) return 1;  // starts-with
  if (lowerText.includes(queryLower)) return 2;    // substring
  if (fuzzyRe.test(rawText)) return 3;             // fuzzy only
  return -1;                                       // no match
}

function getFilteredSessionIndices(sessions: TabManagerSession[], rawQuery: string): number[] {
  const trimmedQuery = rawQuery.trim();
  if (!trimmedQuery) return sessions.map((_, index) => index);

  const fuzzyRe = buildFuzzyPattern(trimmedQuery);
  if (!fuzzyRe) return sessions.map((_, index) => index);

  const substringRe = new RegExp(escapeRegex(trimmedQuery), "i");
  const queryLower = trimmedQuery.toLowerCase();
  const ranked: Array<{ index: number; score: number; nameLen: number }> = [];

  for (let i = 0; i < sessions.length; i++) {
    const name = sessions[i].name || "";
    if (!(substringRe.test(name) || fuzzyRe.test(name))) continue;

    const score = scoreSessionMatch(name.toLowerCase(), name, queryLower, fuzzyRe);
    if (score < 0) continue;

    ranked.push({
      index: i,
      score,
      nameLen: name.length,
    });
  }

  ranked.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.nameLen !== b.nameLen) return a.nameLen - b.nameLen;
    return a.index - b.index;
  });

  return ranked.map((item) => item.index);
}

function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function buildSessionNameHighlightRegex(rawQuery: string): RegExp | null {
  const terms = rawQuery.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const pattern = terms.map((term) => `(${escapeRegex(escapeHtml(term))})`).join("|");
  try {
    return new RegExp(pattern, "gi");
  } catch (_) {
    return null;
  }
}

function highlightSessionName(name: string, highlightRegex: RegExp | null): string {
  const escaped = escapeHtml(name);
  if (!highlightRegex) return escaped;
  return escaped.replace(highlightRegex, "<mark>$1</mark>");
}

function buildLoadSummaryHtml(summary: SessionLoadSummary): string {
  const replaceText = summary.replaceCount === 0
    ? "No existing Tab Manager slots will be replaced."
    : `${summary.replaceCount} Tab Manager ${pluralize(summary.replaceCount, "slot")} will be replaced.`;
  const reuseText = summary.reuseCount === 0
    ? "No matching open tabs will be reused."
    : `${summary.reuseCount} already-open ${pluralize(summary.reuseCount, "tab")} will be reused.`;
  const openText = summary.openCount === 0
    ? "No new tabs need to be opened."
    : `${summary.openCount} new ${pluralize(summary.openCount, "tab")} will be opened.`;

  return `<div class="ht-session-confirm">
      <div class="ht-session-confirm-icon">\u21bb</div>
      <div class="ht-session-confirm-msg">
        Load <span class="ht-session-confirm-title">&ldquo;${escapeHtml(summary.sessionName)}&rdquo;</span>?
        <div class="ht-session-confirm-path">${summary.totalCount} saved ${pluralize(summary.totalCount, "tab")}</div>
      </div>
      <div class="ht-session-confirm-details">
        <div>${replaceText}</div>
        <div>${reuseText}</div>
        <div>${openText}</div>
      </div>
      <div class="ht-session-confirm-hint">y / Enter confirm &middot; n / Esc cancel</div>
    </div>`;
}

function buildSessionPreviewHtml(session: TabManagerSession | undefined): string {
  if (!session) {
    return `<div class="ht-session-preview-empty">Select a session to preview its tabs.</div>`;
  }

  let html = `<div class="ht-session-preview-list">`;

  if (session.entries.length === 0) {
    html += `<div class="ht-session-preview-empty">No tabs in this session.</div>`;
  } else {
    for (let i = 0; i < session.entries.length; i++) {
      const entry = session.entries[i];
      html += `<div class="ht-session-preview-item">
        <span class="ht-session-preview-slot">${i + 1}</span>
        <div class="ht-session-preview-info">
          <div class="ht-session-preview-title">${escapeHtml(entry.title || "Untitled")}</div>
          <div class="ht-session-preview-url">${escapeHtml(extractDomain(entry.url || ""))}</div>
        </div>
      </div>`;
    }
  }

  html += `</div>`;
  return html;
}

async function beginLoadConfirmation(ctx: SessionContext, sessionIdx: number): Promise<void> {
  const target = ctx.sessions[sessionIdx];
  if (!target) return;
  try {
    const result = (await browser.runtime.sendMessage({
      type: "SESSION_LOAD_PLAN",
      name: target.name,
    })) as { ok: boolean; reason?: string; summary?: SessionLoadSummary };
    if (!result.ok || !result.summary) {
      showFeedback(result.reason || "Failed to prepare session load");
      return;
    }
    isLoadConfirmationActive = true;
    pendingLoadSessionName = target.name;
    pendingLoadSummary = result.summary;
    ctx.setSessionIndex(sessionIdx);
    ctx.render();
  } catch (error) {
    reportSessionError("Build session load summary failed", "Failed to prepare session load", error);
  }
}

async function confirmLoadSession(ctx: SessionContext): Promise<void> {
  if (!pendingLoadSessionName) return;
  const target = ctx.sessions.find((session) => session.name === pendingLoadSessionName);
  isLoadConfirmationActive = false;
  pendingLoadSummary = null;
  pendingLoadSessionName = "";
  if (!target) {
    showFeedback("Session not found");
    ctx.render();
    return;
  }
  await loadSession(ctx, target);
}

// -- Save session view --

export async function renderSaveSession(ctx: SessionContext): Promise<void> {
  const { shadow, container } = ctx;
  const saveKey = keyToDisplay(ctx.config.bindings.tabManager.jump.key);
  const closeKey = keyToDisplay(ctx.config.bindings.tabManager.close.key);

  // Fetch current sessions to show count
  const currentSessions = (await browser.runtime.sendMessage({
    type: "SESSION_LIST",
  })) as TabManagerSession[];
  ctx.setSessions(currentSessions);
  const selectedSessionIndex = currentSessions.length === 0
    ? 0
    : Math.min(ctx.sessionIndex, currentSessions.length - 1);
  if (selectedSessionIndex !== ctx.sessionIndex) {
    ctx.setSessionIndex(selectedSessionIndex);
  }
  const selectedSession = currentSessions[selectedSessionIndex];
  const count = currentSessions.length;
  const previewTabsLabel = selectedSession ? `${selectedSession.entries.length} tabs` : "";
  const saveTitleText = count > 0 ? `Save Session (${count})` : "Save Session";

  let html = `<div class="ht-backdrop"></div>
    <div class="ht-tab-manager-container ht-session-list-container ht-session-save-container ht-session-shell">
      <div class="ht-titlebar">
        <div class="ht-traffic-lights">
          <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
        </div>
        <span class="ht-titlebar-text">${saveTitleText}</span>
      </div>
      <div class="ht-session-body">
        <div class="ht-session-input-wrap ht-ui-input-wrap">
          <span class="ht-session-prompt ht-ui-input-prompt">Name:</span>
          <input type="text" class="ht-session-input ht-ui-input-field" value="${escapeHtml(ctx.pendingSaveName)}" placeholder="e.g. Research, Debug, Feature..." maxlength="30" />
        </div>
        <div class="ht-session-error" style="display:none; padding: 4px 14px; font-size: 10px; color: #ff5f57;"></div>
        <div class="ht-session-columns">
          <div class="ht-session-list-pane">
            <div class="ht-tab-manager-list ht-session-list-scroll">`;

  if (currentSessions.length === 0) {
    html += `<div class="ht-session-empty">No saved sessions yet.</div>`;
  } else {
    for (let i = 0; i < currentSessions.length; i++) {
      const session = currentSessions[i];
      const cls = i === selectedSessionIndex ? "ht-session-item active" : "ht-session-item";
      const date = new Date(session.savedAt).toLocaleDateString();
      html += `<div class="${cls}" data-index="${i}">
        <div class="ht-session-name">${escapeHtml(session.name)}</div>
        <span class="ht-session-meta">${session.entries.length} tabs \u00b7 ${date}</span>
      </div>`;
    }
  }

  html += `</div>
          </div>
          <div class="ht-session-preview-pane">
            <div class="ht-session-pane-header ht-ui-pane-header">
              <span class="ht-session-pane-header-text ht-ui-pane-header-text">Preview</span>
              <span class="ht-session-pane-header-meta ht-ui-pane-header-meta">${previewTabsLabel}</span>
            </div>
            <div class="ht-session-detail-content">
              ${buildSessionPreviewHtml(selectedSession)}
            </div>
          </div>
        </div>
        <div class="ht-footer">
          <div class="ht-footer-row">
            <span>Tab ↓ / Shift+Tab ↑</span>
          </div>
          <div class="ht-footer-row">
            <span>${saveKey} save</span>
            <span>${closeKey} back</span>
          </div>
        </div>
      </div>
    </div>`;

  container.innerHTML = html;

  const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
  const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;
  const input = shadow.querySelector(".ht-session-input") as HTMLInputElement;

  backdrop.addEventListener("click", () => {
    resetSessionTransientState();
    ctx.setViewMode("tabManager");
    ctx.render();
  });
  backdrop.addEventListener("mousedown", (event) => event.preventDefault());
  closeBtn.addEventListener("click", () => {
    resetSessionTransientState();
    ctx.setViewMode("tabManager");
    ctx.render();
  });

  shadow.querySelectorAll(".ht-session-item").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt((el as HTMLElement).dataset.index!);
      if (Number.isNaN(idx)) return;
      ctx.setSessionIndex(idx);
      ctx.render();
    });
  });

  input.addEventListener("input", () => {
    ctx.setPendingSaveName(input.value);
  });

  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// -- Session list view --

export function renderSessionList(ctx: SessionContext): void {
  const { shadow, container, config, sessions } = ctx;
  const visibleIndices = getFilteredSessionIndices(sessions, ctx.sessionFilterQuery);
  const highlightRegex = buildSessionNameHighlightRegex(ctx.sessionFilterQuery);
  let selectedSessionIndex = visibleIndices.includes(ctx.sessionIndex)
    ? ctx.sessionIndex
    : (visibleIndices[0] ?? -1);
  if (selectedSessionIndex !== -1 && selectedSessionIndex !== ctx.sessionIndex) {
    ctx.setSessionIndex(selectedSessionIndex);
  }
  const selectedSession = selectedSessionIndex === -1 ? undefined : sessions[selectedSessionIndex];
  const previewTabsLabel = selectedSession ? `${selectedSession.entries.length} tabs` : "";
  const baseTitleText = ctx.sessionFilterQuery.trim()
    ? `Load Sessions (${visibleIndices.length})`
    : "Load Sessions";
  const titleText = baseTitleText;

  let html = `<div class="ht-backdrop"></div>
    <div class="ht-tab-manager-container ht-session-list-container ht-session-shell">
      <div class="ht-titlebar">
        <div class="ht-traffic-lights">
          <button class="ht-dot ht-dot-close" title="Close (Esc)"></button>
        </div>
        <span class="ht-titlebar-text">${titleText}</span>
      </div>
      <div class="ht-session-body">
        <div class="ht-session-filter-wrap ht-ui-input-wrap">
          <span class="ht-session-filter-prompt ht-ui-input-prompt">&gt;</span>
          <input
            type="text"
            class="ht-session-filter-input ht-ui-input-field"
            placeholder="Filter Sessions . . ."
            value="${escapeHtml(ctx.sessionFilterQuery)}"
            maxlength="40"
          />
        </div>
        <div class="ht-session-columns">
          <div class="ht-session-list-pane">
            <div class="ht-tab-manager-list ht-session-list-scroll">`;

  if (sessions.length === 0) {
    html += `<div class="ht-session-empty">No saved sessions</div>`;
  } else if (visibleIndices.length === 0) {
    html += `<div class="ht-session-empty">No matching sessions</div>`;
  } else {
    for (const globalIdx of visibleIndices) {
      const s = sessions[globalIdx];
      const cls = globalIdx === selectedSessionIndex ? "ht-session-item active" : "ht-session-item";
      const itemTabIndex = globalIdx === selectedSessionIndex ? "0" : "-1";
      const date = new Date(s.savedAt).toLocaleDateString();
      const nameContent = isRenameModeActive && globalIdx === selectedSessionIndex
        ? `<input type="text" class="ht-session-rename-input" value="${escapeHtml(s.name)}" maxlength="30" />`
        : `<div class="ht-session-name">${highlightSessionName(s.name, highlightRegex)}</div>`;
      html += `<div class="${cls}" data-index="${globalIdx}" tabindex="${itemTabIndex}" role="button" aria-selected="${globalIdx === selectedSessionIndex ? "true" : "false"}">
        ${nameContent}
        <span class="ht-session-meta">${s.entries.length} tabs \u00b7 ${date}</span>
        <button class="ht-session-delete" data-index="${globalIdx}" title="Delete" tabindex="-1">\u00d7</button>
      </div>`;
    }
  }

  const previewContent = isLoadConfirmationActive && pendingLoadSummary
    ? `${buildLoadSummaryHtml(pendingLoadSummary)}${buildSessionPreviewHtml(selectedSession)}`
    : buildSessionPreviewHtml(selectedSession);

  html += `</div>
          </div>
          <div class="ht-session-preview-pane">
            <div class="ht-session-pane-header ht-ui-pane-header">
              <span class="ht-session-pane-header-text ht-ui-pane-header-text">Preview</span>
              <span class="ht-session-pane-header-meta ht-ui-pane-header-meta">${previewTabsLabel}</span>
            </div>
            <div class="ht-session-detail-content">
              ${previewContent}
            </div>
          </div>
        </div>`;

  const moveUpKey = keyToDisplay(config.bindings.tabManager.moveUp.key);
  const moveDownKey = keyToDisplay(config.bindings.tabManager.moveDown.key);
  const removeKey = keyToDisplay(config.bindings.tabManager.remove.key);

  if (isLoadConfirmationActive) {
    html += `<div class="ht-footer">
        <div class="ht-footer-row">
          <span>Y / Enter confirm</span>
          <span>N / Esc cancel</span>
        </div>
      </div>
    </div>
    </div>`;
  } else if (isOverwriteConfirmationActive) {
    html += `<div class="ht-footer">
        <div class="ht-footer-row">
          <span>Y overwrite "${escapeHtml(selectedSession?.name || "session")}"</span>
          <span>N / Esc cancel</span>
        </div>
      </div>
    </div>
    </div>`;
  } else {
    html += `<div class="ht-footer">
        <div class="ht-footer-row">
          <span>j/k (vim) ${moveUpKey}/${moveDownKey} nav</span>
          <span>R rename</span>
          <span>O overwrite</span>
          <span>${removeKey} del</span>
        </div>
        <div class="ht-footer-row">
          <span>Enter load</span>
          <span>Tab toggle focus</span>
          <span>Esc back</span>
        </div>
      </div>
    </div>
    </div>`;
  }

  container.innerHTML = html;

  const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
  const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;
  const filterInput = shadow.querySelector(".ht-session-filter-input") as HTMLInputElement;

  backdrop.addEventListener("click", () => {
    resetSessionTransientState();
    ctx.setSessionFilterQuery("");
    ctx.setViewMode("tabManager");
    ctx.render();
  });
  backdrop.addEventListener("mousedown", (event) => event.preventDefault());
  closeBtn.addEventListener("click", () => {
    resetSessionTransientState();
    ctx.setSessionFilterQuery("");
    ctx.setViewMode("tabManager");
    ctx.render();
  });

  filterInput.addEventListener("focus", () => {
    sessionListFocusTarget = "filter";
  });

  filterInput.addEventListener("input", () => {
    const nextQuery = filterInput.value;
    const caretPos = filterInput.selectionStart ?? nextQuery.length;
    const nextVisibleIndices = getFilteredSessionIndices(ctx.sessions, nextQuery);
    if (isLoadConfirmationActive) {
      isLoadConfirmationActive = false;
      pendingLoadSummary = null;
      pendingLoadSessionName = "";
    }
    sessionListFocusTarget = "filter";
    ctx.setSessionFilterQuery(nextQuery);
    if (nextVisibleIndices.length > 0) {
      ctx.setSessionIndex(nextVisibleIndices[0]);
    }
    ctx.render();
    const restoredInput = ctx.shadow.querySelector(".ht-session-filter-input") as HTMLInputElement | null;
    if (restoredInput) {
      restoredInput.focus();
      const nextPos = Math.min(caretPos, nextQuery.length);
      restoredInput.setSelectionRange(nextPos, nextPos);
    }
  });

  // Click to start pre-load confirmation (skip if clicking delete button)
  shadow.querySelectorAll(".ht-session-item").forEach((el) => {
    el.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".ht-session-delete")) return;
      const idx = parseInt((el as HTMLElement).dataset.index!);
      if (Number.isNaN(idx)) return;
      sessionListFocusTarget = "list";
      void beginLoadConfirmation(ctx, idx);
    });
  });

  // Click x to delete
  shadow.querySelectorAll(".ht-session-delete").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      const idx = parseInt((el as HTMLElement).dataset.index!);
      if (Number.isNaN(idx)) return;
      sessionListFocusTarget = "list";
      isLoadConfirmationActive = false;
      pendingLoadSummary = null;
      pendingLoadSessionName = "";
      deleteSession(ctx, idx);
    });
  });

  const activeEl = shadow.querySelector(".ht-session-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });

  if (
    filterInput
    && !isRenameModeActive
    && !isOverwriteConfirmationActive
    && !isLoadConfirmationActive
  ) {
    if (sessionListFocusTarget === "filter") {
      const end = filterInput.value.length;
      filterInput.focus();
      filterInput.setSelectionRange(end, end);
    } else {
      const activeSessionItem = shadow.querySelector(".ht-session-item.active") as HTMLElement | null;
      if (activeSessionItem) {
        activeSessionItem.focus();
      } else {
        sessionListFocusTarget = "filter";
        const end = filterInput.value.length;
        filterInput.focus();
        filterInput.setSelectionRange(end, end);
      }
    }
  }
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
    resetSessionTransientState();
    ctx.setViewMode("saveSession");
    ctx.render();
  });
  backdrop.addEventListener("mousedown", (event) => event.preventDefault());
  closeBtn.addEventListener("click", () => {
    resetSessionTransientState();
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
  try {
    const oldName = ctx.sessions[idx].name;
    const result = (await browser.runtime.sendMessage({
      type: "SESSION_REPLACE",
      oldName,
      newName: ctx.pendingSaveName,
    })) as { ok: boolean; reason?: string };
    if (result.ok) {
      showFeedback(`Session "${ctx.pendingSaveName}" saved (replaced "${oldName}")`);
    } else {
      showFeedback(result.reason || "Failed to save session");
    }
    ctx.setViewMode("tabManager");
    ctx.render();
  } catch (error) {
    reportSessionError("Replace session failed", "Failed to replace session", error);
    ctx.render();
  }
}

/** Handle keydown events in replaceSession view. Returns true if handled. */
export function handleReplaceSessionKey(ctx: SessionContext, event: KeyboardEvent): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    ctx.setViewMode("saveSession");
    ctx.render();
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    if (ctx.sessions[ctx.sessionIndex]) replaceSession(ctx, ctx.sessionIndex);
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "moveDown")) {
    event.preventDefault();
    event.stopPropagation();
    if (ctx.sessions.length > 0) {
      ctx.setSessionIndex(Math.min(ctx.sessionIndex + 1, ctx.sessions.length - 1));
      ctx.render();
    }
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "moveUp")) {
    event.preventDefault();
    event.stopPropagation();
    if (ctx.sessions.length > 0) {
      ctx.setSessionIndex(Math.max(ctx.sessionIndex - 1, 0));
      ctx.render();
    }
    return true;
  }
  event.stopPropagation();
  return true;
}

export async function saveSession(ctx: SessionContext, name: string): Promise<void> {
  if (!name.trim()) return;
  try {
    const result = (await browser.runtime.sendMessage({
      type: "SESSION_SAVE",
      name: name.trim(),
    })) as { ok: boolean; reason?: string };
    if (result.ok) {
      ctx.setPendingSaveName("");
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
      ctx.setPendingSaveName("");
      showFeedback(result.reason || "Failed to save session");
      ctx.setViewMode("tabManager");
      ctx.render();
    }
  } catch (error) {
    ctx.setPendingSaveName("");
    reportSessionError("Save session failed", "Failed to save session", error);
    ctx.setViewMode("tabManager");
    ctx.render();
  }
}

export async function loadSession(ctx: SessionContext, session: TabManagerSession): Promise<void> {
  try {
    ctx.close();
    const result = (await browser.runtime.sendMessage({
      type: "SESSION_LOAD",
      name: session.name,
    })) as {
      ok: boolean;
      count?: number;
      openCount?: number;
      reuseCount?: number;
      replaceCount?: number;
    };
    if (result.ok) {
      const count = result.count ?? 0;
      const opened = result.openCount ?? 0;
      const reused = result.reuseCount ?? 0;
      showFeedback(`Session "${session.name}" loaded (${count} tabs · ${opened} opened · ${reused} reused)`);
    }
  } catch (error) {
    reportSessionError("Load session failed", "Failed to load session", error);
  }
}

export async function deleteSession(ctx: SessionContext, idx: number): Promise<void> {
  try {
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
  } catch (error) {
    reportSessionError("Delete session failed", "Failed to delete session", error);
    ctx.render();
  }
}

// -- Session keyboard handlers --

/** Validate session save: check for duplicate name and identical content */
async function validateSessionSave(name: string): Promise<string | null> {
  const [tabManagerList, sessions] = await Promise.all([
    browser.runtime.sendMessage({ type: "TAB_MANAGER_LIST" }) as Promise<TabManagerEntry[]>,
    browser.runtime.sendMessage({ type: "SESSION_LIST" }) as Promise<TabManagerSession[]>,
  ]);
  // Check identical content first (more specific error)
  const currentUrls = tabManagerList.map((entry) => normalizeUrlForMatch(entry.url)).join("\n");
  for (const s of sessions) {
    const sessionUrls = s.entries.map((entry) => normalizeUrlForMatch(entry.url)).join("\n");
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
export function handleSaveSessionKey(ctx: SessionContext, event: KeyboardEvent): boolean {
  if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    event.stopPropagation();

    if (ctx.sessions.length === 0) return true;
    const direction = event.shiftKey ? -1 : 1;
    const length = ctx.sessions.length;
    const next = (ctx.sessionIndex + direction + length) % length;
    ctx.setSessionIndex(next);
    ctx.render();
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    ctx.setViewMode("tabManager");
    ctx.render();
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
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
      void (async () => {
        try {
          const err = await validateSessionSave(input.value);
          if (err) {
            const errorEl = ctx.shadow.querySelector(".ht-session-error") as HTMLElement;
            if (errorEl) {
              errorEl.textContent = err;
              errorEl.style.display = "";
              input.style.borderBottom = "1px solid #ff5f57";
              setTimeout(() => { errorEl.style.display = "none"; input.style.borderBottom = ""; }, 2000);
            }
          } else {
            await saveSession(ctx, input.value);
          }
        } catch (error) {
          reportSessionError("Validate session save failed", "Failed to validate session", error);
        }
      })();
    }
    return true;
  }
  // Let typing through to the input
  event.stopPropagation();
  return true;
}

/** Handle keydown events in sessionList view. Returns true if handled. */
export function handleSessionListKey(ctx: SessionContext, event: KeyboardEvent): boolean {
  // During rename mode, only handle Enter/Escape — let all other keys through to the input
  if (isRenameModeActive) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      isRenameModeActive = false;
      ctx.render();
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const input = ctx.shadow.querySelector(".ht-session-rename-input") as HTMLInputElement;
      if (input && input.value.trim()) {
        const oldName = ctx.sessions[ctx.sessionIndex].name;
        const newName = input.value.trim();
        (async () => {
          try {
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
          } catch (error) {
            isRenameModeActive = false;
            reportSessionError("Rename session failed", "Rename failed", error);
          }
          ctx.render();
        })();
      }
      return true;
    }
    // Let typing reach the input (don't preventDefault)
    event.stopPropagation();
    return true;
  }

  // During overwrite confirmation, only accept y/n/Escape
  if (isOverwriteConfirmationActive) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key.toLowerCase() === "y") {
      const session = ctx.sessions[ctx.sessionIndex];
      isOverwriteConfirmationActive = false;
      (async () => {
        try {
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
        } catch (error) {
          reportSessionError("Overwrite session failed", "Overwrite failed", error);
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

  // Pre-load confirmation: confirm/cancel only
  if (isLoadConfirmationActive) {
    event.preventDefault();
    event.stopPropagation();
    const key = event.key.toLowerCase();
    if (event.key === "Enter" || key === "y") {
      void confirmLoadSession(ctx);
    } else if (event.key === "Escape" || key === "n") {
      isLoadConfirmationActive = false;
      pendingLoadSummary = null;
      pendingLoadSessionName = "";
      ctx.render();
    }
    return true;
  }

  const filterInput = ctx.shadow.querySelector(".ht-session-filter-input") as HTMLInputElement | null;
  const filterInputFocused = !!filterInput && ctx.shadow.activeElement === filterInput;
  if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    event.stopPropagation();
    const visibleIndices = getFilteredSessionIndices(ctx.sessions, ctx.sessionFilterQuery);
    if (filterInputFocused) {
      sessionListFocusTarget = "list";
      const topMatch = visibleIndices[0];
      if (typeof topMatch === "number" && ctx.sessionIndex !== topMatch) {
        ctx.setSessionIndex(topMatch);
        ctx.render();
      } else if (typeof topMatch === "number") {
        filterInput.blur();
        const activeSessionItem = ctx.shadow.querySelector(`.ht-session-item[data-index="${topMatch}"]`) as HTMLElement | null;
        if (activeSessionItem) {
          activeSessionItem.focus();
          activeSessionItem.scrollIntoView({ block: "nearest" });
        }
      } else {
        filterInput.blur();
      }
      return true;
    }

    sessionListFocusTarget = "filter";
    ctx.render();
    return true;
  }

  if (filterInputFocused) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      filterInput.blur();
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (ctx.sessions[ctx.sessionIndex]) {
        sessionListFocusTarget = "list";
        void beginLoadConfirmation(ctx, ctx.sessionIndex);
      }
      return true;
    }
    // Let text editing keys flow to the focused input.
    event.stopPropagation();
    return true;
  }

  if (
    filterInput
    && event.key === "/"
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey
  ) {
    event.preventDefault();
    event.stopPropagation();
    sessionListFocusTarget = "filter";
    filterInput.focus();
    filterInput.setSelectionRange(filterInput.value.length, filterInput.value.length);
    return true;
  }

  if (matchesAction(event, ctx.config, "tabManager", "close") || event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    resetSessionTransientState();
    ctx.setSessionFilterQuery("");
    ctx.setViewMode("tabManager");
    ctx.render();
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "moveDown")) {
    event.preventDefault();
    event.stopPropagation();
    const visibleIndices = getFilteredSessionIndices(ctx.sessions, ctx.sessionFilterQuery);
    if (visibleIndices.length > 0) {
      const currentPos = Math.max(0, visibleIndices.indexOf(ctx.sessionIndex));
      const nextPos = Math.min(currentPos + 1, visibleIndices.length - 1);
      ctx.setSessionIndex(visibleIndices[nextPos]);
      sessionListFocusTarget = "list";
      ctx.render();
    }
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "moveUp")) {
    event.preventDefault();
    event.stopPropagation();
    const visibleIndices = getFilteredSessionIndices(ctx.sessions, ctx.sessionFilterQuery);
    if (visibleIndices.length > 0) {
      const currentPos = Math.max(0, visibleIndices.indexOf(ctx.sessionIndex));
      const nextPos = Math.max(currentPos - 1, 0);
      ctx.setSessionIndex(visibleIndices[nextPos]);
      sessionListFocusTarget = "list";
      ctx.render();
    }
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "jump")) {
    event.preventDefault();
    event.stopPropagation();
    if (ctx.sessions[ctx.sessionIndex]) {
      sessionListFocusTarget = "list";
      void beginLoadConfirmation(ctx, ctx.sessionIndex);
    }
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "remove")) {
    event.preventDefault();
    event.stopPropagation();
    if (ctx.sessions[ctx.sessionIndex]) deleteSession(ctx, ctx.sessionIndex);
    return true;
  }

  // Rename session ("r" key)
  if (
    event.key.toLowerCase() === "r"
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && !event.metaKey
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (ctx.sessions.length === 0) return true;
    isRenameModeActive = true;
    // Re-render to show inline input, then focus it
    ctx.render();
    const input = ctx.shadow.querySelector(".ht-session-rename-input") as HTMLInputElement;
    if (input) input.focus();
    return true;
  }

  // Overwrite session ("o" key) — show confirmation prompt
  if (
    event.key.toLowerCase() === "o"
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && !event.metaKey
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (ctx.sessions.length === 0) return true;
    isOverwriteConfirmationActive = true;
    ctx.render();
    return true;
  }

  event.stopPropagation();
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
      backdrop.addEventListener("mousedown", (event) => event.preventDefault());
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
      try {
        close();
        const result = (await browser.runtime.sendMessage({
          type: "SESSION_LOAD",
          name: session.name,
        })) as { ok: boolean; count?: number };
        if (result.ok) {
          showFeedback(`Session "${session.name}" restored (${result.count} tabs)`);
        }
      } catch (error) {
        reportSessionError("Restore session failed", "Failed to restore session", error);
      }
    }

    function keyHandler(event: KeyboardEvent): void {
      if (!document.getElementById("ht-panel-host")) {
        document.removeEventListener("keydown", keyHandler, true);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (sessions[activeIndex]) restoreSession(sessions[activeIndex]);
        return;
      }
      if (matchesAction(event, config, "tabManager", "moveDown")) {
        event.preventDefault();
        event.stopPropagation();
        activeIndex = Math.min(activeIndex + 1, sessions.length - 1);
        render();
        return;
      }
      if (matchesAction(event, config, "tabManager", "moveUp")) {
        event.preventDefault();
        event.stopPropagation();
        activeIndex = Math.max(activeIndex - 1, 0);
        render();
        return;
      }
      event.stopPropagation();
    }

    document.addEventListener("keydown", keyHandler, true);
    registerPanelCleanup(close);
    render();
    host.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open session restore overlay:", err);
    dismissPanel();
  }
}
