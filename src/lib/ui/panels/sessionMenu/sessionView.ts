import { keyToDisplay } from "../../../common/contracts/keybindings";
import { footerRowHtml } from "../../../common/utils/panelHost";
import { escapeHtml, escapeRegex, extractDomain, buildFuzzyPattern } from "../../../common/utils/helpers";
import { hasActiveSessionConfirmation, SessionTransientState } from "../../../core/sessionMenu/sessionCore";

function scoreSessionMatch(
  lowerText: string,
  rawText: string,
  queryLower: string,
  fuzzyRe: RegExp,
): number {
  if (lowerText === queryLower) return 0;
  if (lowerText.startsWith(queryLower)) return 1;
  if (lowerText.includes(queryLower)) return 2;
  if (fuzzyRe.test(rawText)) return 3;
  return -1;
}

export function getFilteredSessionIndices(sessions: TabManagerSession[], rawQuery: string): number[] {
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
    ranked.push({ index: i, score, nameLen: name.length });
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

export function buildSessionNameHighlightRegex(rawQuery: string): RegExp | null {
  const terms = rawQuery.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const pattern = terms.map((term) => `(${escapeRegex(escapeHtml(term))})`).join("|");
  try {
    return new RegExp(pattern, "gi");
  } catch (_) {
    return null;
  }
}

export function highlightSessionName(name: string, highlightRegex: RegExp | null): string {
  const escaped = escapeHtml(name);
  if (!highlightRegex) return escaped;
  return escaped.replace(highlightRegex, "<mark>$1</mark>");
}

export function getSessionListHalfPageStep(shadow: ShadowRoot): number {
  const listEl = shadow.querySelector(".ht-session-list-scroll") as HTMLElement | null;
  const itemEl = shadow.querySelector(".ht-session-item") as HTMLElement | null;
  const itemHeight = Math.max(1, itemEl?.offsetHeight ?? 34);
  const rows = Math.max(1, Math.floor((listEl?.clientHeight ?? (itemHeight * 8)) / itemHeight));
  return Math.max(1, Math.floor(rows / 2));
}

export function buildLoadSummaryHtml(
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
          <span class="ht-session-plan-text">Session ${renderTabLabel(match.sessionTitle, match.sessionUrl)} &harr; Current ${renderTabLabel(match.openTabTitle, match.openTabUrl)}</span>
        </div>`;
      }
      if (row.change === "replace") {
        return `<div class="ht-session-plan-row ht-session-plan-row-replace">
          <span class="ht-session-plan-sign">~</span>
          <span class="ht-session-plan-slot">${row.slot}</span>
          <span class="ht-session-plan-text">${renderTabLabel(row.currentTitle, row.currentUrl)} &rarr; ${renderTabLabel(row.incomingTitle, row.incomingUrl)}</span>
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
      <div class="ht-session-confirm-icon">&#x21bb;</div>
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

export function buildOverwriteConfirmationHtml(
  session: TabManagerSession | undefined,
  confirmKey: string,
  cancelKey: string,
): string {
  const sessionName = session?.name || "session";
  const savedCount = session?.entries.length ?? 0;
  return `<div class="ht-session-confirm">
      <div class="ht-session-confirm-icon">&#x26A0;</div>
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

export function buildDeleteConfirmationHtml(
  session: TabManagerSession | undefined,
  confirmKey: string,
  cancelKey: string,
): string {
  const sessionName = session?.name || "session";
  const savedCount = session?.entries.length ?? 0;
  return `<div class="ht-session-confirm">
      <div class="ht-session-confirm-icon">&#x26A0;</div>
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

export interface SessionPreviewEntryLike {
  title?: string;
  url?: string;
}

export function buildPreviewEntriesHtml(entries: SessionPreviewEntryLike[], emptyText: string): string {
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

export function buildSessionPreviewHtml(session: TabManagerSession | undefined): string {
  if (!session) return "";
  return buildPreviewEntriesHtml(session.entries, "No tabs in this session.");
}

export function buildSessionPreviewPaneHtml(
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

export function buildSaveSessionFooterHtml(config: KeybindingsConfig, saveKey: string, closeKey: string): string {
  return footerRowHtml([
    { key: saveKey, desc: "save" },
    { key: closeKey, desc: "close" },
  ]);
}

export function buildSessionListFooterHtml(
  config: KeybindingsConfig,
  transientState: SessionTransientState,
): string {
  if (hasActiveSessionConfirmation(transientState)) {
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

export function buildReplaceSessionFooterHtml(config: KeybindingsConfig): string {
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
