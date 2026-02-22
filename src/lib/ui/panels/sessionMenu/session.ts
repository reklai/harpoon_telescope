// Session save/load views rendered inside the shared panel shell.
// Keeps view-specific keyboard semantics in one place to avoid mode drift.

import { keyToDisplay, matchesAction, MAX_SESSIONS } from "../../../common/contracts/keybindings";
import { vimBadgeHtml } from "../../../common/utils/panelHost";
import { escapeHtml } from "../../../common/utils/helpers";
import { showFeedback } from "../../../common/utils/feedback";
import { toastMessages } from "../../../common/utils/toastMessages";
import {
  SessionTransientState,
  createSessionTransientState,
  deriveSessionListViewModel,
  resetSessionTransientState as resetSessionTransientStateValue,
  startSessionDeleteConfirmation,
  startSessionLoadConfirmation,
  startSessionOverwriteConfirmation,
  startSessionRenameMode,
  stopSessionDeleteConfirmation,
  stopSessionLoadConfirmation,
  stopSessionOverwriteConfirmation,
  stopSessionRenameMode,
  withSessionListFocusTarget,
} from "../../../core/sessionMenu/sessionCore";
import {
  deleteSessionByName as deleteSessionByNameRemote,
  listSessions,
  loadSessionByName,
  loadSessionPlanByName,
  renameSession,
  replaceSession as replaceSessionByName,
  saveSessionByName,
  updateSession,
} from "../../../adapters/runtime/sessionApi";
import { listTabManagerEntries } from "../../../adapters/runtime/tabManagerApi";
import {
  moveVisibleSelectionByDirection,
  moveVisibleSelectionFromWheel,
  moveVisibleSelectionHalfPage,
} from "../../../core/panel/panelListController";
import {
  buildDeleteConfirmationHtml,
  buildLoadSummaryHtml,
  buildOverwriteConfirmationHtml,
  buildPreviewEntriesHtml,
  buildReplaceSessionFooterHtml,
  buildSaveSessionFooterHtml,
  buildSessionListFooterHtml,
  buildSessionNameHighlightRegex,
  buildSessionPreviewHtml,
  buildSessionPreviewPaneHtml,
  getFilteredSessionIndices,
  getSessionListHalfPageStep,
  highlightSessionName,
} from "./sessionView";

let sessionTransientState = createSessionTransientState();

export function resetSessionTransientState(): void {
  sessionTransientState = resetSessionTransientStateValue();
}

function setSessionTransientState(nextState: SessionTransientState): void {
  sessionTransientState = nextState;
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


async function beginLoadConfirmation(ctx: SessionContext, sessionIdx: number): Promise<void> {
  const target = ctx.sessions[sessionIdx];
  if (!target) return;
  try {
    const result = await loadSessionPlanByName(target.name);
    if (!result.ok || !result.summary) {
      showFeedback(result.reason || toastMessages.sessionLoadPlanFailed);
      return;
    }
    setSessionTransientState(
      startSessionLoadConfirmation(sessionTransientState, target.name, result.summary),
    );
    ctx.setSessionIndex(sessionIdx);
    ctx.render();
  } catch (error) {
    reportSessionError("Build session load summary failed", "Failed to prepare session load", error);
  }
}

async function confirmLoadSession(ctx: SessionContext): Promise<void> {
  if (!sessionTransientState.pendingLoadSessionName) return;
  const target = ctx.sessions.find((session) => session.name === sessionTransientState.pendingLoadSessionName);
  setSessionTransientState(stopSessionLoadConfirmation(sessionTransientState));
  if (!target) {
    showFeedback(toastMessages.sessionNotFound);
    ctx.render();
    return;
  }
  await loadSession(ctx, target);
}

export type SessionPanelMode = "saveSession" | "sessionList" | "replaceSession";

export function refreshSessionViewFooter(ctx: SessionContext, viewMode: SessionPanelMode): void {
  const footerEl = ctx.shadow.querySelector(".ht-footer") as HTMLElement | null;
  if (!footerEl) return;

  if (viewMode === "saveSession") {
    const saveKey = keyToDisplay(ctx.config.bindings.tabManager.jump.key);
    const closeKey = keyToDisplay(ctx.config.bindings.tabManager.close.key);
    footerEl.innerHTML = buildSaveSessionFooterHtml(ctx.config, saveKey, closeKey);
    return;
  }

  if (viewMode === "sessionList") {
    footerEl.innerHTML = buildSessionListFooterHtml(ctx.config, sessionTransientState);
    return;
  }

  footerEl.innerHTML = buildReplaceSessionFooterHtml(ctx.config);
}

export async function renderSaveSession(ctx: SessionContext): Promise<void> {
  const { shadow, container } = ctx;
  const saveKey = keyToDisplay(ctx.config.bindings.tabManager.jump.key);
  const closeKey = keyToDisplay(ctx.config.bindings.tabManager.close.key);

  // Load both datasets upfront so validation and preview are consistent in one render.
  const [currentSessions, tabManagerEntries] = await Promise.all([
    listSessions(),
    listTabManagerEntries(),
  ]);
  ctx.setSessions(currentSessions);
  const count = currentSessions.length;
  const previewHtml = buildPreviewEntriesHtml(tabManagerEntries, "No tabs in Tab Manager.");
  const saveTitleText = count > 0 ? `Save Session (${count})` : "Save Session";

  let html = `<div class="ht-backdrop"></div>
    <div class="ht-tab-manager-container ht-session-list-container ht-session-save-container ht-session-shell">
      <div class="ht-titlebar">
        <div class="ht-traffic-lights">
          <button class="ht-dot ht-dot-close" title="Close (${escapeHtml(closeKey)})"></button>
        </div>
        <span class="ht-titlebar-text">${saveTitleText}</span>
        ${vimBadgeHtml(ctx.config)}
      </div>
      <div class="ht-session-body">
        <div class="ht-session-input-wrap ht-ui-input-wrap">
          <span class="ht-session-prompt ht-ui-input-prompt">Name:</span>
          <input type="text" class="ht-session-input ht-ui-input-field" value="${escapeHtml(ctx.pendingSaveName)}" placeholder="e.g. Research, Debug, Feature..." maxlength="30" />
        </div>
        <div class="ht-session-error" style="display:none; padding: 4px 14px; font-size: 10px; color: #ff5f57;"></div>
        ${buildSessionPreviewPaneHtml(
          tabManagerEntries.length,
          tabManagerEntries.length > 0,
          previewHtml,
          "No tabs in Tab Manager.",
        )}
        <div class="ht-footer">
          ${buildSaveSessionFooterHtml(ctx.config, saveKey, closeKey)}
        </div>
      </div>
    </div>`;

  container.innerHTML = html;

  const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
  const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;
  const input = shadow.querySelector(".ht-session-input") as HTMLInputElement;

  backdrop.addEventListener("click", () => {
    ctx.close();
  });
  backdrop.addEventListener("mousedown", (event) => event.preventDefault());
  closeBtn.addEventListener("click", () => {
    ctx.close();
  });

  input.addEventListener("input", () => {
    ctx.setPendingSaveName(input.value);
  });

  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

export function renderSessionList(ctx: SessionContext): void {
  const { shadow, container, config, sessions } = ctx;
  const visibleIndices = getFilteredSessionIndices(sessions, ctx.sessionFilterQuery);
  const highlightRegex = buildSessionNameHighlightRegex(ctx.sessionFilterQuery);
  const listModel = deriveSessionListViewModel(
    sessions,
    visibleIndices,
    ctx.sessionIndex,
    ctx.sessionFilterQuery,
    sessionTransientState,
  );
  const selectedSessionIndex = listModel.selectedSessionIndex;
  if (listModel.shouldSyncSessionIndex) {
    ctx.setSessionIndex(selectedSessionIndex);
  }
  const selectedSession = listModel.selectedSession;
  const previewTargetSession = listModel.previewTargetSession;
  const titleText = listModel.titleText;
  const closeKey = keyToDisplay(config.bindings.tabManager.close.key);
  const confirmYesKey = keyToDisplay(config.bindings.session.confirmYes.key);
  const confirmNoKey = keyToDisplay(config.bindings.session.confirmNo.key);

  let html = `<div class="ht-backdrop"></div>
    <div class="ht-tab-manager-container ht-session-list-container ht-session-shell">
      <div class="ht-titlebar">
        <div class="ht-traffic-lights">
          <button class="ht-dot ht-dot-close" title="Close (${escapeHtml(closeKey)})"></button>
        </div>
        <span class="ht-titlebar-text">${titleText}</span>
        ${vimBadgeHtml(ctx.config)}
      </div>
      <div class="ht-session-body">
        <div class="ht-session-filter-wrap ht-ui-input-wrap">
          <span class="ht-session-filter-prompt ht-ui-input-prompt">&gt;</span>
          <input
            type="text"
            class="ht-session-filter-input ht-ui-input-field"
            placeholder="Search Sessions . . ."
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
      const nameContent = sessionTransientState.isRenameModeActive && globalIdx === selectedSessionIndex
        ? `<input type="text" class="ht-session-rename-input" value="${escapeHtml(s.name)}" maxlength="30" />`
        : `<div class="ht-session-name">${highlightSessionName(s.name, highlightRegex)}</div>`;
      html += `<div class="${cls}" data-index="${globalIdx}" tabindex="${itemTabIndex}" role="button" aria-selected="${globalIdx === selectedSessionIndex ? "true" : "false"}">
        ${nameContent}
        <span class="ht-session-meta">${s.entries.length} tabs \u00b7 ${date}</span>
        <button class="ht-session-delete" data-index="${globalIdx}" title="Delete" tabindex="-1">\u00d7</button>
      </div>`;
    }
  }

  const previewContent = sessionTransientState.isLoadConfirmationActive && sessionTransientState.pendingLoadSummary
    ? `${buildLoadSummaryHtml(sessionTransientState.pendingLoadSummary, confirmYesKey, confirmNoKey)}${buildSessionPreviewHtml(selectedSession)}`
    : sessionTransientState.isOverwriteConfirmationActive
      ? `${buildOverwriteConfirmationHtml(selectedSession, confirmYesKey, confirmNoKey)}${buildSessionPreviewHtml(selectedSession)}`
      : sessionTransientState.isDeleteConfirmationActive
        ? `${buildDeleteConfirmationHtml(previewTargetSession, confirmYesKey, confirmNoKey)}${buildSessionPreviewHtml(previewTargetSession)}`
        : buildSessionPreviewHtml(selectedSession);

  html += `</div>
          </div>
          ${buildSessionPreviewPaneHtml(
            previewTargetSession?.entries.length ?? 0,
            !!previewTargetSession,
            previewContent,
            "Select a session to preview its tabs.",
          )}
        </div>`;

  const footerHtml = buildSessionListFooterHtml(config, sessionTransientState);
  html += `${footerHtml
    ? `<div class="ht-footer">${footerHtml}</div>`
    : ""}
    </div>
    </div>`;

  container.innerHTML = html;

  const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
  const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;
  const filterInput = shadow.querySelector(".ht-session-filter-input") as HTMLInputElement;
  const listPane = shadow.querySelector(".ht-session-list-pane") as HTMLElement | null;

  function setSessionListPaneFocus(target: "filter" | "list"): void {
    setSessionTransientState(withSessionListFocusTarget(sessionTransientState, target));
    if (listPane) {
      listPane.classList.toggle("focused", target === "list");
    }
  }

  backdrop.addEventListener("click", () => {
    ctx.close();
  });
  backdrop.addEventListener("mousedown", (event) => event.preventDefault());
  closeBtn.addEventListener("click", () => {
    ctx.close();
  });

  filterInput.addEventListener("focus", () => {
    setSessionListPaneFocus("filter");
  });

  filterInput.addEventListener("input", () => {
    const nextQuery = filterInput.value;
    const caretPos = filterInput.selectionStart ?? nextQuery.length;
    const nextVisibleIndices = getFilteredSessionIndices(ctx.sessions, nextQuery);
    if (sessionTransientState.isLoadConfirmationActive) {
      setSessionTransientState(stopSessionLoadConfirmation(sessionTransientState));
    }
    setSessionListPaneFocus("filter");
    ctx.setSessionFilterQuery(nextQuery);
    if (nextVisibleIndices.length > 0) {
      ctx.setSessionIndex(nextVisibleIndices[0]);
    } else {
      ctx.setSessionIndex(-1);
    }
    ctx.render();
    const restoredInput = ctx.shadow.querySelector(".ht-session-filter-input") as HTMLInputElement | null;
    if (restoredInput) {
      restoredInput.focus();
      const nextPos = Math.min(caretPos, nextQuery.length);
      restoredInput.setSelectionRange(nextPos, nextPos);
    }
  });

  // Click row to open load confirmation; destructive actions are guarded separately.
  shadow.querySelectorAll(".ht-session-item").forEach((el) => {
    el.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".ht-session-delete")) return;
      if (
        sessionTransientState.isRenameModeActive
        || sessionTransientState.isLoadConfirmationActive
        || sessionTransientState.isOverwriteConfirmationActive
        || sessionTransientState.isDeleteConfirmationActive
      ) return;
      const idx = parseInt((el as HTMLElement).dataset.index!);
      if (Number.isNaN(idx)) return;
      setSessionListPaneFocus("list");
      void beginLoadConfirmation(ctx, idx);
    });
  });

  // Delete button enters confirmation mode in preview pane.
  shadow.querySelectorAll(".ht-session-delete").forEach((el) => {
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      if (sessionTransientState.isRenameModeActive) {
        setSessionTransientState(stopSessionRenameMode(sessionTransientState));
        ctx.render();
        return;
      }
      if (
        sessionTransientState.isLoadConfirmationActive
        || sessionTransientState.isOverwriteConfirmationActive
        || sessionTransientState.isDeleteConfirmationActive
      ) return;
      const idx = parseInt((el as HTMLElement).dataset.index!);
      if (Number.isNaN(idx)) return;
      setSessionListPaneFocus("list");
      beginDeleteConfirmation(ctx, idx);
    });
  });

  // Keep inline rename input mouse-native (selection, caret, drag) inside the panel.
  shadow.querySelectorAll(".ht-session-rename-input").forEach((el) => {
    const renameInput = el as HTMLInputElement;
    renameInput.addEventListener("mousedown", (event) => event.stopPropagation());
    renameInput.addEventListener("click", (event) => event.stopPropagation());
  });

  const activeEl = shadow.querySelector(".ht-session-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });

  const listScroll = shadow.querySelector(".ht-session-list-scroll") as HTMLElement | null;
  if (listScroll) {
    listScroll.addEventListener("focusin", () => {
      setSessionListPaneFocus("list");
    });
  }
  if (
    listScroll
    && !sessionTransientState.isRenameModeActive
    && !sessionTransientState.isOverwriteConfirmationActive
    && !sessionTransientState.isDeleteConfirmationActive
    && !sessionTransientState.isLoadConfirmationActive
  ) {
    listScroll.addEventListener("wheel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const indices = getFilteredSessionIndices(ctx.sessions, ctx.sessionFilterQuery);
      if (indices.length === 0) return;
      const nextIndex = moveVisibleSelectionFromWheel(indices, ctx.sessionIndex, event.deltaY);
      if (nextIndex === ctx.sessionIndex) return;
      setSessionListPaneFocus("list");
      ctx.setSessionIndex(nextIndex);
      ctx.render();
    });
  }

  if (
    filterInput
    && !sessionTransientState.isRenameModeActive
    && !sessionTransientState.isOverwriteConfirmationActive
    && !sessionTransientState.isDeleteConfirmationActive
    && !sessionTransientState.isLoadConfirmationActive
  ) {
    if (sessionTransientState.sessionListFocusTarget === "filter") {
      setSessionListPaneFocus("filter");
      const end = filterInput.value.length;
      filterInput.focus();
      filterInput.setSelectionRange(end, end);
    } else {
      const activeSessionItem = shadow.querySelector(".ht-session-item.active") as HTMLElement | null;
      if (activeSessionItem) {
        setSessionListPaneFocus("list");
        activeSessionItem.focus();
      } else {
        setSessionListPaneFocus("filter");
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
          <button class="ht-dot ht-dot-close" title="Close (${escapeHtml(keyToDisplay(ctx.config.bindings.tabManager.close.key))})"></button>
        </div>
        <span class="ht-titlebar-text">Replace which session?</span>
        ${vimBadgeHtml(ctx.config)}
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
    ${buildReplaceSessionFooterHtml(ctx.config)}
  </div></div>`;

  container.innerHTML = html;

  const backdrop = shadow.querySelector(".ht-backdrop") as HTMLElement;
  const closeBtn = shadow.querySelector(".ht-dot-close") as HTMLElement;

  backdrop.addEventListener("click", () => {
    ctx.close();
  });
  backdrop.addEventListener("mousedown", (event) => event.preventDefault());
  closeBtn.addEventListener("click", () => {
    ctx.close();
  });

  // Click to replace
  shadow.querySelectorAll(".ht-session-item").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt((el as HTMLElement).dataset.index!);
      replaceSession(ctx, idx);
    });
  });

  const listEl = shadow.querySelector(".ht-tab-manager-list") as HTMLElement | null;
  if (listEl) {
    listEl.addEventListener("wheel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (sessions.length === 0) return;
      const next = moveVisibleSelectionFromWheel(
        sessions.map((_, index) => index),
        ctx.sessionIndex,
        event.deltaY,
      );
      if (next === ctx.sessionIndex) return;
      ctx.setSessionIndex(next);
      ctx.render();
    });
  }

  const activeEl = shadow.querySelector(".ht-session-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

async function replaceSession(ctx: SessionContext, idx: number): Promise<void> {
  try {
    const oldName = ctx.sessions[idx].name;
    const result = await replaceSessionByName(oldName, ctx.pendingSaveName);
    if (result.ok) {
      showFeedback(toastMessages.sessionSaveReplacing(ctx.pendingSaveName, oldName));
    } else {
      showFeedback(result.reason || toastMessages.sessionSaveFailed);
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
  if (matchesAction(event, ctx.config, "tabManager", "close")) {
    event.preventDefault();
    event.stopPropagation();
    ctx.close();
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "jump")) {
    event.preventDefault();
    event.stopPropagation();
    if (ctx.sessions[ctx.sessionIndex]) replaceSession(ctx, ctx.sessionIndex);
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "moveDown")) {
    event.preventDefault();
    event.stopPropagation();
    if (ctx.sessions.length > 0) {
      const nextIndex = moveVisibleSelectionByDirection(
        ctx.sessions.map((_, index) => index),
        ctx.sessionIndex,
        "down",
      );
      ctx.setSessionIndex(nextIndex);
      ctx.render();
    }
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "moveUp")) {
    event.preventDefault();
    event.stopPropagation();
    if (ctx.sessions.length > 0) {
      const nextIndex = moveVisibleSelectionByDirection(
        ctx.sessions.map((_, index) => index),
        ctx.sessionIndex,
        "up",
      );
      ctx.setSessionIndex(nextIndex);
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
    const result = await saveSessionByName(name.trim());
    if (result.ok) {
      ctx.setPendingSaveName("");
      showFeedback(toastMessages.sessionSave(name.trim()));
      ctx.setViewMode("tabManager");
      ctx.render();
    } else if (result.reason && result.reason.includes(`Max ${MAX_SESSIONS}`)) {
      // At capacity — prompt user to pick a session to replace
      ctx.setPendingSaveName(name.trim());
      const sessions = await listSessions();
      ctx.setSessions(sessions);
      ctx.setSessionIndex(0);
      ctx.setViewMode("replaceSession");
      ctx.render();
    } else if (result.reason && result.reason.startsWith("Identical to ")) {
      ctx.close();
      showFeedback(toastMessages.sessionSaveReopenRequired);
    } else if (result.reason) {
      showSaveSessionInlineError(ctx, result.reason);
    } else {
      ctx.setPendingSaveName("");
      showFeedback(result.reason || toastMessages.sessionSaveFailed);
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
    const result = await loadSessionByName(session.name);
    if (result.ok) {
      const count = result.count ?? 0;
      showFeedback(toastMessages.sessionLoad(session.name, count));
    }
  } catch (error) {
    reportSessionError("Load session failed", "Failed to load session", error);
  }
}

export async function deleteSession(ctx: SessionContext, idx: number): Promise<void> {
  const session = ctx.sessions[idx];
  if (!session) return;
  await deleteSessionByName(ctx, session.name);
}

async function deleteSessionByName(ctx: SessionContext, name: string): Promise<void> {
  try {
    await deleteSessionByNameRemote(name);
    const sessions = await listSessions();
    setSessionTransientState(stopSessionDeleteConfirmation(sessionTransientState));
    ctx.setSessions(sessions);
    ctx.setSessionIndex(Math.min(ctx.sessionIndex, Math.max(sessions.length - 1, 0)));
    ctx.render();
  } catch (error) {
    setSessionTransientState(stopSessionDeleteConfirmation(sessionTransientState));
    reportSessionError("Delete session failed", "Failed to delete session", error);
    ctx.render();
  }
}

function beginDeleteConfirmation(ctx: SessionContext, sessionIdx: number): void {
  const target = ctx.sessions[sessionIdx];
  if (!target) return;
  setSessionTransientState(startSessionDeleteConfirmation(sessionTransientState, target.name));
  ctx.setSessionIndex(sessionIdx);
  ctx.render();
}

async function confirmDeleteSession(ctx: SessionContext): Promise<void> {
  if (!sessionTransientState.pendingDeleteSessionName) return;
  const targetName = sessionTransientState.pendingDeleteSessionName;
  await deleteSessionByName(ctx, targetName);
}

function showSaveSessionInlineError(ctx: SessionContext, message: string): boolean {
  const input = ctx.shadow.querySelector(".ht-session-input") as HTMLInputElement | null;
  const errorEl = ctx.shadow.querySelector(".ht-session-error") as HTMLElement | null;
  if (!input || !errorEl) return false;
  errorEl.textContent = message;
  errorEl.style.display = "";
  input.style.borderBottom = "1px solid #ff5f57";
  setTimeout(() => {
    errorEl.style.display = "none";
    input.style.borderBottom = "";
  }, 2000);
  return true;
}

/** Handle keydown events in saveSession view. Returns true if handled. */
export function handleSaveSessionKey(ctx: SessionContext, event: KeyboardEvent): boolean {
  const input = ctx.shadow.querySelector(".ht-session-input") as HTMLInputElement | null;

  if (matchesAction(event, ctx.config, "tabManager", "close")) {
    event.preventDefault();
    event.stopPropagation();
    ctx.close();
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "jump")) {
    event.preventDefault();
    event.stopPropagation();
    if (input && !input.value.trim()) {
      showSaveSessionInlineError(ctx, "A session name is required");
      return true;
    }
    if (input) {
      void (async () => {
        await saveSession(ctx, input.value);
      })();
    }
    return true;
  }
  // Save view keeps text editing local to the input.
  event.stopPropagation();
  return true;
}

/** Handle keydown events in sessionList view. Returns true if handled. */
export function handleSessionListKey(ctx: SessionContext, event: KeyboardEvent): boolean {
  const standardNav = ctx.config.navigationMode === "standard";
  const filterInput = ctx.shadow.querySelector(".ht-session-filter-input") as HTMLInputElement | null;
  const filterInputFocused = !!filterInput && ctx.shadow.activeElement === filterInput;
  const isSessionConfirmYes = matchesAction(event, ctx.config, "session", "confirmYes");
  const isSessionConfirmNo = matchesAction(event, ctx.config, "session", "confirmNo");
  const getVisibleSelectedSession = (): TabManagerSession | undefined => {
    const visibleIndices = getFilteredSessionIndices(ctx.sessions, ctx.sessionFilterQuery);
    if (!visibleIndices.includes(ctx.sessionIndex)) return undefined;
    return ctx.sessions[ctx.sessionIndex];
  };

  // Rename mode is intentionally narrow: submit/cancel are handled; text keys pass through.
  if (sessionTransientState.isRenameModeActive) {
    if (matchesAction(event, ctx.config, "tabManager", "close")) {
      event.preventDefault();
      event.stopPropagation();
      setSessionTransientState(stopSessionRenameMode(sessionTransientState));
      ctx.render();
      return true;
    }
    if (matchesAction(event, ctx.config, "tabManager", "jump")) {
      event.preventDefault();
      event.stopPropagation();
      const input = ctx.shadow.querySelector(".ht-session-rename-input") as HTMLInputElement;
      if (input && input.value.trim()) {
        const target = ctx.sessions[ctx.sessionIndex];
        if (!target) {
          setSessionTransientState(stopSessionRenameMode(sessionTransientState));
          ctx.render();
          return true;
        }
        const oldName = target.name;
        const newName = input.value.trim();
        (async () => {
          try {
            const result = await renameSession(oldName, newName);
            setSessionTransientState(stopSessionRenameMode(sessionTransientState));
            if (result.ok) {
              showFeedback(toastMessages.sessionRename(newName));
              const sessions = await listSessions();
              ctx.setSessions(sessions);
            } else {
              showFeedback(result.reason || toastMessages.sessionRenameFailed);
            }
          } catch (error) {
            setSessionTransientState(stopSessionRenameMode(sessionTransientState));
            reportSessionError("Rename session failed", "Rename failed", error);
          }
          ctx.render();
        })();
      }
      return true;
    }
    event.stopPropagation();
    return true;
  }

  // Confirmation modes lock interaction to explicit confirm/cancel bindings.
  if (sessionTransientState.isOverwriteConfirmationActive) {
    event.preventDefault();
    event.stopPropagation();
    if (isSessionConfirmYes) {
      const session = ctx.sessions[ctx.sessionIndex];
      setSessionTransientState(stopSessionOverwriteConfirmation(sessionTransientState));
      (async () => {
        try {
          const result = await updateSession(session.name);
          if (result.ok) {
            showFeedback(toastMessages.sessionOverwrite(session.name));
            const sessions = await listSessions();
            ctx.setSessions(sessions);
          } else {
            showFeedback(result.reason || toastMessages.sessionOverwriteFailed);
          }
        } catch (error) {
          reportSessionError("Overwrite session failed", "Overwrite failed", error);
        }
        ctx.render();
      })();
    } else if (isSessionConfirmNo) {
      setSessionTransientState(stopSessionOverwriteConfirmation(sessionTransientState));
      ctx.render();
    }
    return true;
  }

  if (sessionTransientState.isDeleteConfirmationActive) {
    event.preventDefault();
    event.stopPropagation();
    if (isSessionConfirmYes) {
      void confirmDeleteSession(ctx);
    } else if (isSessionConfirmNo) {
      setSessionTransientState(stopSessionDeleteConfirmation(sessionTransientState));
      ctx.render();
    }
    return true;
  }

  if (sessionTransientState.isLoadConfirmationActive) {
    event.preventDefault();
    event.stopPropagation();
    if (isSessionConfirmYes) {
      void confirmLoadSession(ctx);
    } else if (isSessionConfirmNo) {
      setSessionTransientState(stopSessionLoadConfirmation(sessionTransientState));
      ctx.render();
    }
    return true;
  }

  if (matchesAction(event, ctx.config, "session", "clearSearch")) {
    event.preventDefault();
    event.stopPropagation();
    setSessionTransientState(withSessionListFocusTarget(sessionTransientState, "filter"));
    ctx.setSessionFilterQuery("");
    const visibleIndices = getFilteredSessionIndices(ctx.sessions, "");
    if (visibleIndices.length > 0) {
      ctx.setSessionIndex(visibleIndices[0]);
    }
    ctx.render();
    const restoredInput = ctx.shadow.querySelector(".ht-session-filter-input") as HTMLInputElement | null;
    if (restoredInput) {
      restoredInput.focus();
      restoredInput.setSelectionRange(0, 0);
    }
    return true;
  }

  if (matchesAction(event, ctx.config, "session", "focusList")) {
    event.preventDefault();
    event.stopPropagation();
    const visibleIndices = getFilteredSessionIndices(ctx.sessions, ctx.sessionFilterQuery);
    if (filterInputFocused) {
      setSessionTransientState(withSessionListFocusTarget(sessionTransientState, "list"));
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

    // List focus is one-way from this key; focusSearch returns to input.
    return true;
  }

  if (filterInputFocused) {
    if (matchesAction(event, ctx.config, "tabManager", "close")) {
      if (!standardNav) {
        event.preventDefault();
        event.stopPropagation();
        filterInput.blur();
        return true;
      }
    }
    if (matchesAction(event, ctx.config, "tabManager", "jump")) {
      event.preventDefault();
      event.stopPropagation();
      if (getVisibleSelectedSession()) {
        setSessionTransientState(withSessionListFocusTarget(sessionTransientState, "list"));
        void beginLoadConfirmation(ctx, ctx.sessionIndex);
      }
      return true;
    }
    if (!matchesAction(event, ctx.config, "tabManager", "close")) {
      event.stopPropagation();
      return true;
    }
  }

  if (
    standardNav
    && !filterInputFocused
    && event.ctrlKey
    && !event.altKey
    && !event.metaKey
  ) {
    const lowerKey = event.key.toLowerCase();
    if (lowerKey === "d" || lowerKey === "u") {
      event.preventDefault();
      event.stopPropagation();
      const visibleIndices = getFilteredSessionIndices(ctx.sessions, ctx.sessionFilterQuery);
      if (visibleIndices.length > 0) {
        const jump = getSessionListHalfPageStep(ctx.shadow);
        const nextIndex = moveVisibleSelectionHalfPage(
          visibleIndices,
          ctx.sessionIndex,
          jump,
          lowerKey === "d" ? "down" : "up",
        );
        setSessionTransientState(withSessionListFocusTarget(sessionTransientState, "list"));
        ctx.setSessionIndex(nextIndex);
        ctx.render();
      }
      return true;
    }
  }

  if (filterInput && matchesAction(event, ctx.config, "session", "focusSearch")) {
    event.preventDefault();
    event.stopPropagation();
    setSessionTransientState(withSessionListFocusTarget(sessionTransientState, "filter"));
    filterInput.focus();
    filterInput.setSelectionRange(filterInput.value.length, filterInput.value.length);
    return true;
  }

  if (matchesAction(event, ctx.config, "tabManager", "close")) {
    event.preventDefault();
    event.stopPropagation();
    ctx.close();
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "moveDown")) {
    event.preventDefault();
    event.stopPropagation();
    const visibleIndices = getFilteredSessionIndices(ctx.sessions, ctx.sessionFilterQuery);
    if (visibleIndices.length > 0) {
      const nextIndex = moveVisibleSelectionByDirection(visibleIndices, ctx.sessionIndex, "down");
      ctx.setSessionIndex(nextIndex);
      setSessionTransientState(withSessionListFocusTarget(sessionTransientState, "list"));
      ctx.render();
    }
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "moveUp")) {
    event.preventDefault();
    event.stopPropagation();
    const visibleIndices = getFilteredSessionIndices(ctx.sessions, ctx.sessionFilterQuery);
    if (visibleIndices.length > 0) {
      const nextIndex = moveVisibleSelectionByDirection(visibleIndices, ctx.sessionIndex, "up");
      ctx.setSessionIndex(nextIndex);
      setSessionTransientState(withSessionListFocusTarget(sessionTransientState, "list"));
      ctx.render();
    }
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "jump")) {
    event.preventDefault();
    event.stopPropagation();
    if (getVisibleSelectedSession()) {
      setSessionTransientState(withSessionListFocusTarget(sessionTransientState, "list"));
      void beginLoadConfirmation(ctx, ctx.sessionIndex);
    }
    return true;
  }
  if (matchesAction(event, ctx.config, "tabManager", "remove")) {
    event.preventDefault();
    event.stopPropagation();
    if (getVisibleSelectedSession()) beginDeleteConfirmation(ctx, ctx.sessionIndex);
    return true;
  }

  if (matchesAction(event, ctx.config, "session", "rename")) {
    event.preventDefault();
    event.stopPropagation();
    if (!getVisibleSelectedSession()) return true;
    setSessionTransientState(startSessionRenameMode(sessionTransientState));
    // Re-render first so the rename input exists, then place caret at end.
    ctx.render();
    const input = ctx.shadow.querySelector(".ht-session-rename-input") as HTMLInputElement;
    if (input) {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
    return true;
  }

  if (matchesAction(event, ctx.config, "session", "overwrite")) {
    event.preventDefault();
    event.stopPropagation();
    if (!getVisibleSelectedSession()) return true;
    setSessionTransientState(startSessionOverwriteConfirmation(sessionTransientState));
    ctx.render();
    return true;
  }

  event.stopPropagation();
  return true;
}
