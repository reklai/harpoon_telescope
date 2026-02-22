// Session save/load views for the tab manager overlay.
// Renders the save-session input and session-list views inside the tab manager panel.
// Also provides standalone session-restore overlay for browser startup.

import { keyToDisplay, matchesAction, loadKeybindings, MAX_SESSIONS } from "../../../shared/keybindings";
import {
  createPanelHost,
  removePanelHost,
  registerPanelCleanup,
  getBaseStyles,
  footerRowHtml,
  vimBadgeHtml,
  dismissPanel,
} from "../../shared/panelHost";
import { escapeHtml, escapeRegex, extractDomain, buildFuzzyPattern } from "../../../shared/helpers";
import { showFeedback } from "../../../shared/feedback";
import { toastMessages } from "../../../shared/toastMessages";
import restoreStyles from "./session.css";
import {
  SessionTransientState,
  createSessionTransientState,
  deriveSessionListViewModel,
  hasActiveSessionConfirmation,
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

function getSessionListHalfPageStep(shadow: ShadowRoot): number {
  const listEl = shadow.querySelector(".ht-session-list-scroll") as HTMLElement | null;
  const itemEl = shadow.querySelector(".ht-session-item") as HTMLElement | null;
  const itemHeight = Math.max(1, itemEl?.offsetHeight ?? 34);
  const rows = Math.max(1, Math.floor((listEl?.clientHeight ?? (itemHeight * 8)) / itemHeight));
  return Math.max(1, Math.floor(rows / 2));
}

function buildLoadSummaryHtml(
  summary: SessionLoadSummary,
  confirmKey: string,
  cancelKey: string,
): string {
  const slotDiffs = Array.isArray(summary.slotDiffs)
    ? [...summary.slotDiffs].sort((a, b) => a.slot - b.slot)
    : [];
  const reuseMatches = Array.isArray(summary.reuseMatches) ? summary.reuseMatches : [];
  const reuseBySlot = new Map<number, SessionLoadReuseMatch>();
  for (const match of reuseMatches) {
    reuseBySlot.set(match.slot, match);
  }

  const removeCount = slotDiffs.filter((row) => row.change === "remove").length;
  const replaceCount = slotDiffs.filter(
    (row) => row.change === "replace" && !reuseBySlot.has(row.slot),
  ).length;

  const renderTabLabel = (title?: string, url?: string): string => {
    const display = (title || "").trim() || extractDomain(url || "") || "Untitled";
    return `&ldquo;${escapeHtml(display)}&rdquo;`;
  };

  const planRowsHtml = slotDiffs.length === 0
    ? `<div class="ht-session-plan-empty">No slot changes detected.</div>`
    : slotDiffs.map((row) => {
      const match = reuseBySlot.get(row.slot);
      if (match) {
        return `<div class="ht-session-plan-row ht-session-plan-row-reuse">
          <span class="ht-session-plan-sign">=</span>
          <span class="ht-session-plan-slot">${row.slot}</span>
          <span class="ht-session-plan-text">Session ${renderTabLabel(match.sessionTitle, match.sessionUrl)} \u21C4 Current ${renderTabLabel(match.openTabTitle, match.openTabUrl)}</span>
        </div>`;
      }
      if (row.change === "replace") {
        return `<div class="ht-session-plan-row ht-session-plan-row-replace">
          <span class="ht-session-plan-sign">~</span>
          <span class="ht-session-plan-slot">${row.slot}</span>
          <span class="ht-session-plan-text">${renderTabLabel(row.currentTitle, row.currentUrl)} \u2192 ${renderTabLabel(row.incomingTitle, row.incomingUrl)}</span>
        </div>`;
      }
      if (row.change === "add") {
        return `<div class="ht-session-plan-row ht-session-plan-row-add">
          <span class="ht-session-plan-sign">+</span>
          <span class="ht-session-plan-slot">${row.slot}</span>
          <span class="ht-session-plan-text">${renderTabLabel(row.incomingTitle, row.incomingUrl)} (new tab)</span>
        </div>`;
      }
      return `<div class="ht-session-plan-row ht-session-plan-row-remove">
        <span class="ht-session-plan-sign">-</span>
        <span class="ht-session-plan-slot">${row.slot}</span>
        <span class="ht-session-plan-text">${renderTabLabel(row.currentTitle, row.currentUrl)} (slot cleared)</span>
      </div>`;
    }).join("");

  return `<div class="ht-session-confirm">
      <div class="ht-session-confirm-icon">\u21bb</div>
      <div class="ht-session-confirm-msg">
        Load <span class="ht-session-confirm-title">&ldquo;${escapeHtml(summary.sessionName)}&rdquo;</span>?
        <div class="ht-session-confirm-path">${summary.totalCount} saved ${pluralize(summary.totalCount, "tab")}</div>
      </div>
      <div class="ht-session-plan-totals">
        NEW <strong>(+)</strong> &middot; DELETED <strong>(-)</strong> &middot; REPLACED <strong>(~)</strong> &middot; UNCHANGED <strong>(=)</strong>
      </div>
      <div class="ht-session-plan-list">${planRowsHtml}</div>
      <div class="ht-session-confirm-hint">
        <span class="ht-confirm-key ht-confirm-key-yes">${escapeHtml(confirmKey)}</span> confirm
        &middot;
        <span class="ht-confirm-key ht-confirm-key-no">${escapeHtml(cancelKey)}</span> cancel
      </div>
    </div>`;
}

function buildOverwriteConfirmationHtml(
  session: TabManagerSession | undefined,
  confirmKey: string,
  cancelKey: string,
): string {
  const sessionName = session?.name || "session";
  const savedCount = session?.entries.length ?? 0;
  return `<div class="ht-session-confirm">
      <div class="ht-session-confirm-icon">\u26A0</div>
      <div class="ht-session-confirm-msg">
        Overwrite <span class="ht-session-confirm-title">&ldquo;${escapeHtml(sessionName)}&rdquo;</span>?
        <div class="ht-session-confirm-path">${savedCount} saved ${pluralize(savedCount, "tab")} will be replaced</div>
      </div>
      <div class="ht-session-confirm-hint">
        <span class="ht-confirm-key ht-confirm-key-yes">${escapeHtml(confirmKey)}</span> overwrite
        &middot;
        <span class="ht-confirm-key ht-confirm-key-no">${escapeHtml(cancelKey)}</span> cancel
      </div>
    </div>`;
}

function buildDeleteConfirmationHtml(
  session: TabManagerSession | undefined,
  confirmKey: string,
  cancelKey: string,
): string {
  const sessionName = session?.name || "session";
  const savedCount = session?.entries.length ?? 0;
  return `<div class="ht-session-confirm">
      <div class="ht-session-confirm-icon">\u26A0</div>
      <div class="ht-session-confirm-msg">
        Delete <span class="ht-session-confirm-title">&ldquo;${escapeHtml(sessionName)}&rdquo;</span>?
        <div class="ht-session-confirm-path">${savedCount} saved ${pluralize(savedCount, "tab")} will be removed</div>
      </div>
      <div class="ht-session-confirm-hint">
        <span class="ht-confirm-key ht-confirm-key-yes">${escapeHtml(confirmKey)}</span> delete
        &middot;
        <span class="ht-confirm-key ht-confirm-key-no">${escapeHtml(cancelKey)}</span> cancel
      </div>
    </div>`;
}

interface SessionPreviewEntryLike {
  title?: string;
  url?: string;
}

function buildPreviewEntriesHtml(entries: SessionPreviewEntryLike[], emptyText: string): string {
  let html = `<div class="ht-session-preview-list">`;

  if (entries.length === 0) {
    html += `<div class="ht-session-preview-empty">${escapeHtml(emptyText)}</div>`;
  } else {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
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

function buildSessionPreviewHtml(session: TabManagerSession | undefined): string {
  if (!session) {
    return "";
  }
  return buildPreviewEntriesHtml(session.entries, "No tabs in this session.");
}

function buildSessionPreviewPaneHtml(
  tabCount: number,
  hasPreview: boolean,
  previewHtml: string,
  placeholderText: string,
): string {
  const tabLabel = pluralize(tabCount, "Tab", "Tabs");

  return `<div class="ht-session-preview-pane ht-preview-pane">
      <div class="ht-preview-header ht-ui-pane-header">
        <span class="ht-session-pane-header-text ht-ui-pane-header-text">Preview - ${tabCount} ${tabLabel}</span>
      </div>
      <div class="ht-preview-placeholder" ${hasPreview ? 'style="display:none;"' : ""}>${escapeHtml(placeholderText)}</div>
      <div class="ht-preview-content" ${hasPreview ? "" : 'style="display:none;"'}>${previewHtml}</div>
    </div>`;
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

function buildSaveSessionFooterHtml(config: KeybindingsConfig, saveKey: string, closeKey: string): string {
  return footerRowHtml([
    { key: saveKey, desc: "save" },
    { key: closeKey, desc: "close" },
  ]);
}

function buildSessionListFooterHtml(config: KeybindingsConfig): string {
  if (hasActiveSessionConfirmation(sessionTransientState)) {
    return "";
  }

  const moveUpKey = keyToDisplay(config.bindings.tabManager.moveUp.key);
  const moveDownKey = keyToDisplay(config.bindings.tabManager.moveDown.key);
  const focusListKey = keyToDisplay(config.bindings.session.focusList.key);
  const focusSearchKey = keyToDisplay(config.bindings.session.focusSearch.key);
  const clearSearchKey = keyToDisplay(config.bindings.session.clearSearch.key);
  const renameKey = keyToDisplay(config.bindings.session.rename.key);
  const overwriteKey = keyToDisplay(config.bindings.session.overwrite.key);
  const removeKey = keyToDisplay(config.bindings.tabManager.remove.key);
  const loadKey = keyToDisplay(config.bindings.tabManager.jump.key);
  const closeKey = keyToDisplay(config.bindings.tabManager.close.key);
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
      { key: focusListKey, desc: "list" },
      { key: focusSearchKey, desc: "search" },
      { key: clearSearchKey, desc: "clear-search" },
      { key: renameKey, desc: "rename" },
      { key: overwriteKey, desc: "overwrite" },
      { key: removeKey, desc: "del" },
      { key: loadKey, desc: "load" },
      { key: closeKey, desc: "close" },
    ])}`;
}

function buildReplaceSessionFooterHtml(config: KeybindingsConfig): string {
  const moveUpKey = keyToDisplay(config.bindings.tabManager.moveUp.key);
  const moveDownKey = keyToDisplay(config.bindings.tabManager.moveDown.key);
  const replaceKey = keyToDisplay(config.bindings.tabManager.jump.key);
  const closeKey = keyToDisplay(config.bindings.tabManager.close.key);
  const navHints = config.navigationMode === "standard"
    ? [
      { key: "j/k", desc: "nav" },
      { key: `${moveUpKey}/${moveDownKey}`, desc: "nav" },
    ]
    : [
      { key: `${moveUpKey}/${moveDownKey}`, desc: "nav" },
    ];
  return `${footerRowHtml(navHints)}
    ${footerRowHtml([
      { key: replaceKey, desc: "replace" },
      { key: closeKey, desc: "close" },
    ])}`;
}

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
    footerEl.innerHTML = buildSessionListFooterHtml(ctx.config);
    return;
  }

  footerEl.innerHTML = buildReplaceSessionFooterHtml(ctx.config);
}

// -- Save session view --

export async function renderSaveSession(ctx: SessionContext): Promise<void> {
  const { shadow, container } = ctx;
  const saveKey = keyToDisplay(ctx.config.bindings.tabManager.jump.key);
  const closeKey = keyToDisplay(ctx.config.bindings.tabManager.close.key);

  // Fetch current sessions for name collision context + tab-manager list for live save preview.
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

// -- Session list view --

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

  const footerHtml = buildSessionListFooterHtml(config);
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

  // Click to start pre-load confirmation (skip if clicking delete button)
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

  // Click x to delete
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

  // Keep inline rename input mouse-native (cursor placement, selection, drag-select).
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

// -- Session keyboard handlers --

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
  // Let typing through to the input
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

  // During rename mode, only handle jump/close — let all other keys through to the input
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
    // Let typing reach the input (don't preventDefault)
    event.stopPropagation();
    return true;
  }

  // During overwrite confirmation, only accept configured confirm/cancel keys.
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

  // During delete confirmation, only accept configured confirm/cancel keys.
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

  // Pre-load confirmation: confirm/cancel only
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

    // One-way list focus; use session.focusSearch to return to filter.
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
      // Let text editing keys flow to the focused input.
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

  // Rename session
  if (matchesAction(event, ctx.config, "session", "rename")) {
    event.preventDefault();
    event.stopPropagation();
    if (!getVisibleSelectedSession()) return true;
    setSessionTransientState(startSessionRenameMode(sessionTransientState));
    // Re-render to show inline input, then focus it
    ctx.render();
    const input = ctx.shadow.querySelector(".ht-session-rename-input") as HTMLInputElement;
    if (input) {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
    return true;
  }

  // Overwrite session — show confirmation prompt
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

// -- Standalone session restore overlay (shown on browser startup) --

export async function openSessionRestoreOverlay(): Promise<void> {
  try {
    const sessions = await listSessions();
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
      window.removeEventListener("ht-navigation-mode-changed", onNavigationModeChanged);
      removePanelHost();
    }

    function renderRestoreFooter(): void {
      const footer = shadow.querySelector(".ht-footer") as HTMLElement | null;
      if (!footer) return;
      const moveUpKey = keyToDisplay(config.bindings.tabManager.moveUp.key);
      const moveDownKey = keyToDisplay(config.bindings.tabManager.moveDown.key);
      const restoreKey = keyToDisplay(config.bindings.tabManager.jump.key);
      const closeKey = keyToDisplay(config.bindings.tabManager.close.key);
      const navHints = config.navigationMode === "standard"
        ? [
          { key: "j/k", desc: "nav" },
          { key: `${moveUpKey}/${moveDownKey}`, desc: "nav" },
        ]
        : [
          { key: `${moveUpKey}/${moveDownKey}`, desc: "nav" },
        ];
      footer.innerHTML = `${footerRowHtml(navHints)}
      ${footerRowHtml([
        { key: restoreKey, desc: "restore" },
        { key: closeKey, desc: "decline" },
      ])}`;
    }

    function onNavigationModeChanged(): void {
      renderRestoreFooter();
    }

    function render(): void {
      let html = `<div class="ht-backdrop"></div>
        <div class="ht-session-restore-container">
          <div class="ht-titlebar">
            <div class="ht-traffic-lights">
              <button class="ht-dot ht-dot-close" title="Decline (${escapeHtml(keyToDisplay(config.bindings.tabManager.close.key))})"></button>
            </div>
            <span class="ht-titlebar-text">Restore Session?</span>
            ${vimBadgeHtml(config)}
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
        <div class="ht-footer"></div>
      </div>`;

      container.innerHTML = html;
      renderRestoreFooter();

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

      const listEl = shadow.querySelector(".ht-session-restore-list") as HTMLElement | null;
      if (listEl) {
        listEl.addEventListener("wheel", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (sessions.length === 0) return;
          const next = moveVisibleSelectionFromWheel(
            sessions.map((_, index) => index),
            activeIndex,
            event.deltaY,
          );
          if (next === activeIndex) return;
          activeIndex = next;
          render();
        });
      }

      const activeEl = shadow.querySelector(".ht-session-restore-item.active");
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    }

    async function restoreSession(session: TabManagerSession): Promise<void> {
      try {
        close();
        const result = await loadSessionByName(session.name);
        if (result.ok) {
          showFeedback(toastMessages.sessionRestore(session.name, result.count ?? 0));
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

      if (matchesAction(event, config, "tabManager", "close")) {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (matchesAction(event, config, "tabManager", "jump")) {
        event.preventDefault();
        event.stopPropagation();
        if (sessions[activeIndex]) restoreSession(sessions[activeIndex]);
        return;
      }
      if (matchesAction(event, config, "tabManager", "moveDown")) {
        event.preventDefault();
        event.stopPropagation();
        activeIndex = moveVisibleSelectionByDirection(
          sessions.map((_, index) => index),
          activeIndex,
          "down",
        );
        render();
        return;
      }
      if (matchesAction(event, config, "tabManager", "moveUp")) {
        event.preventDefault();
        event.stopPropagation();
        activeIndex = moveVisibleSelectionByDirection(
          sessions.map((_, index) => index),
          activeIndex,
          "up",
        );
        render();
        return;
      }
      event.stopPropagation();
    }

    document.addEventListener("keydown", keyHandler, true);
    window.addEventListener("ht-navigation-mode-changed", onNavigationModeChanged);
    registerPanelCleanup(close);
    render();
    host.focus();
  } catch (err) {
    console.error("[Harpoon Telescope] Failed to open session restore overlay:", err);
    dismissPanel();
  }
}
