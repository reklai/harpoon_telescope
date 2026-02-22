import { keyToDisplay } from "../../../common/contracts/keybindings";
import { footerRowHtml, vimBadgeHtml } from "../../../common/utils/panelHost";
import { escapeHtml, escapeRegex } from "../../../common/utils/helpers";

export const MAX_DOM_ELEMENTS = 200_000;
export const MAX_TEXT_BYTES = 10 * 1024 * 1024;

export const VALID_FILTERS: Record<string, SearchFilter> = {
  "/code": "code",
  "/headings": "headings",
  "/img": "images",
  "/links": "links",
};

export const ITEM_HEIGHT = 28;
export const POOL_BUFFER = 5;

const TAG_COLORS: Record<string, { bg: string; fg: string }> = {
  PRE: { bg: "rgba(175,130,255,0.2)", fg: "#af82ff" },
  CODE: { bg: "rgba(175,130,255,0.2)", fg: "#af82ff" },
  H1: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  H2: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  H3: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  H4: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  H5: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  H6: { bg: "rgba(50,215,75,0.2)", fg: "#32d74b" },
  A: { bg: "rgba(255,159,10,0.2)", fg: "#ff9f0a" },
  IMG: { bg: "rgba(0,199,190,0.2)", fg: "#00c7be" },
};

const DEFAULT_TAG_COLOR = { bg: "rgba(255,255,255,0.08)", fg: "#808080" };
const URL_BADGE_COLOR = { bg: "rgba(255,45,146,0.2)", fg: "#ff2d92" };

export function getTagBadgeColors(tag: string | undefined): { bg: string; fg: string } {
  if (!tag) return DEFAULT_TAG_COLOR;
  return TAG_COLORS[tag] || DEFAULT_TAG_COLOR;
}

function getTagBadgeInlineStyle(tag: string | undefined): string {
  const colors = getTagBadgeColors(tag);
  return ` style="background:${colors.bg};color:${colors.fg};"`;
}

function getUrlBadgeInlineStyle(): string {
  return ` style="background:${URL_BADGE_COLOR.bg};color:${URL_BADGE_COLOR.fg};"`;
}

export function buildSearchCurrentPageHtml(
  config: KeybindingsConfig,
  closeKeyDisplay: string,
): string {
  return `
      <div class="ht-backdrop"></div>
      <div class="ht-search-page-container">
        <div class="ht-titlebar">
          <div class="ht-traffic-lights">
            <button class="ht-dot ht-dot-close" title="Close (${escapeHtml(closeKeyDisplay)})"></button>
          </div>
          <span class="ht-titlebar-text">
            <span class="ht-title-label">Search \u2014 Current Page</span>
            <span class="ht-title-sep">|</span>
            <span class="ht-title-filters">Filters:
              <span class="ht-title-filter" data-filter="code">/code</span>
              <span class="ht-title-filter" data-filter="headings">/headings</span>
              <span class="ht-title-filter" data-filter="images">/img</span>
              <span class="ht-title-filter" data-filter="links">/links</span>
            </span>
            <span class="ht-title-count"></span>
          </span>
          ${vimBadgeHtml(config)}
        </div>
        <div class="ht-search-page-body">
          <div class="ht-search-page-input-wrap ht-ui-input-wrap">
            <span class="ht-prompt ht-ui-input-prompt">&gt;</span>
            <input type="text" class="ht-search-page-input ht-ui-input-field" placeholder="Search Current Page . . ." />
          </div>
          <div class="ht-filter-pills"></div>
          <div class="ht-search-page-columns">
            <div class="ht-results-pane">
              <div class="ht-results-sentinel"></div>
              <div class="ht-results-list"></div>
            </div>
            <div class="ht-preview-pane">
              <div class="ht-preview-header ht-ui-pane-header">Preview</div>
              <div class="ht-preview-breadcrumb" style="display:none;"></div>
              <div class="ht-preview-placeholder">Select a result to preview</div>
              <div class="ht-preview-content" style="display:none;"></div>
            </div>
          </div>
          <div class="ht-footer"></div>
        </div>
      </div>
    `;
}

export function buildSearchFooterHtml(config: KeybindingsConfig): string {
  const upKey = keyToDisplay(config.bindings.search.moveUp.key);
  const downKey = keyToDisplay(config.bindings.search.moveDown.key);
  const switchPaneKey = keyToDisplay(config.bindings.search.switchPane.key);
  const focusSearchKey = keyToDisplay(config.bindings.search.focusSearch.key);
  const clearSearchKey = keyToDisplay(config.bindings.search.clearSearch.key);
  const acceptKey = keyToDisplay(config.bindings.search.accept.key);
  const closeKey = keyToDisplay(config.bindings.search.close.key);

  const navHints = config.navigationMode === "standard"
    ? [
      { key: "j/k", desc: "nav" },
      { key: `${upKey}/${downKey}`, desc: "nav" },
      { key: "Ctrl+D/U", desc: "half-page" },
    ]
    : [
      { key: `${upKey}/${downKey}`, desc: "nav" },
    ];

  return `
        ${footerRowHtml(navHints)}
        ${footerRowHtml([
          { key: switchPaneKey, desc: "list" },
          { key: focusSearchKey, desc: "search" },
          { key: clearSearchKey, desc: "clear-search" },
          { key: acceptKey, desc: "jump" },
          { key: closeKey, desc: "close" },
        ])}
      `;
}

export function buildHighlightRegex(query: string): RegExp | null {
  if (!query) return null;
  try {
    const terms = query.split(/\s+/).filter(Boolean);
    const pattern = terms.map((term) => `(${escapeRegex(escapeHtml(term))})`).join("|");
    return new RegExp(pattern, "gi");
  } catch (_) {
    return null;
  }
}

export function highlightText(text: string, highlightRegex: RegExp | null): string {
  const escaped = escapeHtml(text);
  if (!highlightRegex) return escaped;
  return escaped.replace(highlightRegex, "<mark>$1</mark>");
}

export function renderSearchPreview(options: {
  results: GrepResult[];
  activeIndex: number;
  highlightRegex: RegExp | null;
  previewHeader: HTMLElement;
  previewBreadcrumb: HTMLElement;
  previewPlaceholder: HTMLElement;
  previewContent: HTMLElement;
  enrichResult: (result: GrepResult) => void;
}): void {
  const {
    results,
    activeIndex,
    highlightRegex,
    previewHeader,
    previewBreadcrumb,
    previewPlaceholder,
    previewContent,
    enrichResult,
  } = options;

  if (results.length === 0 || !results[activeIndex]) {
    previewHeader.textContent = "Preview";
    previewBreadcrumb.style.display = "none";
    previewPlaceholder.style.display = "flex";
    previewContent.style.display = "none";
    return;
  }

  const activeResult = results[activeIndex];
  enrichResult(activeResult);

  const showPlaceholder = (show: boolean): void => {
    previewPlaceholder.style.display = show ? "flex" : "none";
    previewContent.style.display = show ? "none" : "block";
    previewBreadcrumb.style.display = show ? "none" : "";
  };

  const highlight = (text: string): string => highlightText(text, highlightRegex);

  const tag = activeResult.tag || "";
  previewHeader.textContent = `Preview \u2014 L${activeResult.lineNumber}`;
  showPlaceholder(false);

  let primaryRowHtml = "";
  if (tag) {
    primaryRowHtml += `<span class="ht-bc-tag"${getTagBadgeInlineStyle(tag)}>${escapeHtml(tag)}</span>`;
  }
  if (activeResult.ancestorHeading) {
    primaryRowHtml += `<span class="ht-bc-heading">${escapeHtml(activeResult.ancestorHeading)}</span>`;
  }

  let breadcrumbHtml = primaryRowHtml
    ? `<span class="ht-bc-row ht-bc-row-main">${primaryRowHtml}</span>`
    : "";

  if (activeResult.href) {
    let displayHref = activeResult.href;
    try {
      const parsed = new URL(activeResult.href);
      displayHref = parsed.pathname + parsed.hash;
    } catch (_) {
      // Keep raw href when URL parsing fails.
    }
    breadcrumbHtml += `<span class="ht-bc-row ht-bc-row-url"><span class="ht-bc-href"><span class="ht-bc-tag"${getUrlBadgeInlineStyle()}>URL</span> -&gt; ${escapeHtml(displayHref)}</span></span>`;
  }

  if (breadcrumbHtml) {
    previewBreadcrumb.innerHTML = breadcrumbHtml;
    previewBreadcrumb.style.display = "";
  } else {
    previewBreadcrumb.style.display = "none";
  }

  const contextLines = activeResult.domContext && activeResult.domContext.length > 0
    ? activeResult.domContext
    : activeResult.context && activeResult.context.length > 0
      ? activeResult.context
      : [activeResult.text];

  const isCode = tag === "PRE" || tag === "CODE";
  let html = "";

  if (isCode) {
    html += '<div class="ht-preview-code-ctx">';
    for (let i = 0; i < contextLines.length; i++) {
      const line = contextLines[i];
      const trimmed = line.replace(/\s+/g, " ").trim();
      const isMatch = trimmed === activeResult.text || line.replace(/\s+/g, " ").trim() === activeResult.text;
      const cls = isMatch ? "ht-preview-line match" : "ht-preview-line";
      const lineContent = isMatch ? highlight(line) : escapeHtml(line);
      html += `<span class="${cls}"><span class="ht-line-num">${i + 1}</span>${lineContent}</span>`;
    }
    html += "</div>";
  } else {
    html += '<div class="ht-preview-prose-ctx">';
    for (let i = 0; i < contextLines.length; i++) {
      const line = contextLines[i];
      const isMatch = line === activeResult.text || line.replace(/\s+/g, " ").trim() === activeResult.text;
      const cls = isMatch ? "ht-preview-line match" : "ht-preview-line";
      const lineContent = isMatch ? highlight(line) : escapeHtml(line);
      html += `<span class="${cls}">${lineContent}</span>`;
    }
    html += "</div>";
  }

  previewContent.innerHTML = html;
  const matchLine = previewContent.querySelector(".match");
  if (matchLine) {
    matchLine.scrollIntoView({ block: "center" });
  }
}
