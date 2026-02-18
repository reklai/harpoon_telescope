// Page grep and content extraction.
// Uses a character-by-character fuzzy scoring algorithm (no regex backtracking).
// Supports combinable structural filters (code, headings, links) via SearchFilter[].
// Code blocks (<pre>) are split into individual lines. Each result is tagged
// with its source element type for badge display.
// Lines are cached and invalidated via MutationObserver for near-instant re-search.

const CONTEXT_LINES = 5;
const MAX_RESULTS = 200;

// -- Fuzzy scoring constants --
const SCORE_CONSECUTIVE = 8;    // bonus per consecutive matched char
const SCORE_WORD_BOUNDARY = 10; // match starts after separator or camelCase
const SCORE_START = 6;          // match starts at position 0
const SCORE_BASE = 1;           // base score per matched char
const PENALTY_DISTANCE = -1;    // per-char gap between matched chars

const WORD_SEPARATORS = new Set([" ", "-", "_", ".", "/", "\\", ":", "(", ")"]);

/** A line of text with its source element and optional DOM node reference */
interface TaggedLine {
  text: string;
  lower: string;  // pre-lowercased for fuzzy matching (avoid per-search allocation)
  tag: string;    // PRE, H1, H2, A, CODE, P, SPAN, etc.
  nodeRef?: WeakRef<Node>;
  ancestorHeading?: string; // nearest heading text above this element
  href?: string;            // link href (for A tags)
}

// -- Line cache --
// Stores collected lines so subsequent keystrokes don't re-walk the DOM.
// Invalidated by MutationObserver when page content changes.

interface LineCache {
  all: TaggedLine[] | null;
  code: TaggedLine[] | null;
  headings: TaggedLine[] | null;
  links: TaggedLine[] | null;
  observer: MutationObserver | null;
  invalidateTimer: ReturnType<typeof setTimeout> | null;
}

const cache: LineCache = {
  all: null,
  code: null,
  headings: null,
  links: null,
  observer: null,
  invalidateTimer: null,
};

function invalidateCache(): void {
  cache.all = null;
  cache.code = null;
  cache.headings = null;
  cache.links = null;
}

/** Start observing DOM mutations. Call on telescope open. */
export function initLineCache(): void {
  invalidateCache();
  if (cache.observer) cache.observer.disconnect();
  cache.observer = new MutationObserver(() => {
    // Debounce — don't invalidate on every tiny mutation
    if (cache.invalidateTimer) clearTimeout(cache.invalidateTimer);
    cache.invalidateTimer = setTimeout(invalidateCache, 500);
  });
  cache.observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

/** Stop observing and release cache. Call on telescope close. */
export function destroyLineCache(): void {
  if (cache.observer) {
    cache.observer.disconnect();
    cache.observer = null;
  }
  if (cache.invalidateTimer) {
    clearTimeout(cache.invalidateTimer);
    cache.invalidateTimer = null;
  }
  invalidateCache();
}

// -- Visibility check --

/** Check if an element is visible (offsetParent check, allow fixed/sticky) */
function isVisible(el: HTMLElement): boolean {
  if (el === document.body) return true;
  if (!el.offsetParent && el.style.position !== "fixed" && el.style.position !== "sticky") {
    return false;
  }
  return true;
}

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

/** Walk up and backward through the DOM to find the nearest heading */
function findAncestorHeading(node: Node): string | undefined {
  let el: Element | null = node instanceof Element ? node : node.parentElement;
  if (!el) return undefined;

  // First check ancestors (heading might be a parent, e.g. text inside <h2>)
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    if (HEADING_TAGS.has(cur.tagName)) {
      return (cur.textContent || "").replace(/\s+/g, " ").trim() || undefined;
    }
    cur = cur.parentElement;
  }

  // Walk backward through preceding siblings and their descendants
  cur = el;
  while (cur && cur !== document.body) {
    let sib = cur.previousElementSibling;
    while (sib) {
      // Check the sibling itself
      if (HEADING_TAGS.has(sib.tagName)) {
        return (sib.textContent || "").replace(/\s+/g, " ").trim() || undefined;
      }
      // Check last heading descendant of the sibling (deepest preceding heading)
      const headings = sib.querySelectorAll("h1, h2, h3, h4, h5, h6");
      if (headings.length > 0) {
        const last = headings[headings.length - 1];
        return (last.textContent || "").replace(/\s+/g, " ").trim() || undefined;
      }
      sib = sib.previousElementSibling;
    }
    cur = cur.parentElement;
  }
  return undefined;
}

/** Extract href from the nearest ancestor <a> element */
function findHref(node: Node): string | undefined {
  let el: Element | null = node instanceof Element ? node : node.parentElement;
  while (el && el !== document.body) {
    if (el.tagName === "A") {
      return (el as HTMLAnchorElement).href || undefined;
    }
    el = el.parentElement;
  }
  return undefined;
}

/** DOM-context lines: the context block element, extract text from the same DOM parent.
 *  For <pre> blocks: split into lines and return surrounding code lines.
 *  For other elements: get the parent block's full text split by sentences/lines. */
function getDomContext(node: Node, matchText: string, tag: string): string[] {
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return [matchText];

  // For PRE/CODE: get the full code block and extract surrounding lines
  if (tag === "PRE" || tag === "CODE") {
    let codeBlock: Element | null = el;
    while (codeBlock && codeBlock.tagName !== "PRE" && codeBlock !== document.body) {
      codeBlock = codeBlock.parentElement;
    }
    if (codeBlock && codeBlock.tagName === "PRE") {
      const lines = (codeBlock.textContent || "").split("\n");
      const trimmedMatch = matchText.replace(/\s+/g, " ").trim();
      let matchIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].replace(/\s+/g, " ").trim() === trimmedMatch) {
          matchIdx = i;
          break;
        }
      }
      if (matchIdx >= 0) {
        const start = Math.max(0, matchIdx - CONTEXT_LINES);
        const end = Math.min(lines.length, matchIdx + CONTEXT_LINES + 1);
        return lines.slice(start, end).map((l) => l.replace(/\t/g, "  "));
      }
      // Fallback: return first few lines if match not found by exact text
      return lines.slice(0, CONTEXT_LINES * 2 + 1).map((l) => l.replace(/\t/g, "  "));
    }
  }

  // For other elements: walk up to find a meaningful block container
  const blockTags = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "BLOCKQUOTE", "LI", "TD", "TH",
    "FIGCAPTION", "DETAILS", "SUMMARY", "ASIDE", "MAIN", "NAV", "HEADER", "FOOTER",
  ]);
  let block: Element | null = el;
  while (block && block !== document.body) {
    if (blockTags.has(block.tagName) || HEADING_TAGS.has(block.tagName)) break;
    block = block.parentElement;
  }
  if (!block || block === document.body) block = el;

  // Get the block's text content, split into chunks
  const blockText = (block.textContent || "").replace(/\s+/g, " ").trim();
  if (blockText.length <= 200) return [blockText];

  // Split into sentences for longer blocks
  const sentences = blockText.split(/(?<=[.!?])\s+/);
  const matchLower = matchText.toLowerCase();
  let matchSentIdx = -1;
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].toLowerCase().includes(matchLower)) {
      matchSentIdx = i;
      break;
    }
  }
  if (matchSentIdx >= 0) {
    const start = Math.max(0, matchSentIdx - 2);
    const end = Math.min(sentences.length, matchSentIdx + 3);
    return sentences.slice(start, end);
  }
  return [blockText.slice(0, 300)];
}

// -- Fuzzy matching --

/** Score a single term against a candidate string.
 *  Returns null if no match, or a non-negative score (higher = better). */
function scoreTerm(term: string, candidate: string): number | null {
  const termLen = term.length;
  const candLen = candidate.length;
  if (termLen === 0) return 0;
  if (termLen > candLen) return null;

  let score = 0;
  let termIdx = 0;
  let prevMatchIdx = -2; // tracks consecutive bonuses (-2 = no previous match)

  for (let i = 0; i < candLen && termIdx < termLen; i++) {
    if (candidate[i] === term[termIdx]) {
      score += SCORE_BASE;

      // Consecutive bonus
      if (i === prevMatchIdx + 1) {
        score += SCORE_CONSECUTIVE;
      }

      // Word boundary bonus
      if (i === 0) {
        score += SCORE_START;
      } else {
        const prev = candidate[i - 1];
        if (WORD_SEPARATORS.has(prev)) {
          score += SCORE_WORD_BOUNDARY;
        }
        // camelCase boundary skipped — both strings are pre-lowercased
      }

      // Distance penalty (gap between this match and previous)
      if (prevMatchIdx >= 0) {
        const gap = i - prevMatchIdx - 1;
        if (gap > 0) {
          score += gap * PENALTY_DISTANCE;
        }
      }

      prevMatchIdx = i;
      termIdx++;
    }
  }

  // All term chars must be found
  if (termIdx < termLen) return null;
  return score;
}

/** Fuzzy match a multi-word query against a candidate string.
 *  Each space-separated term must match independently.
 *  Returns null for no match, or a summed score. */
function fuzzyMatch(query: string, candidate: string): number | null {
  const terms = query.split(" ");
  let totalScore = 0;

  for (let t = 0; t < terms.length; t++) {
    const term = terms[t];
    if (term.length === 0) continue;
    const s = scoreTerm(term, candidate);
    if (s === null) return null;
    totalScore += s;
  }

  return totalScore;
}

// -- Tag resolution --

/** Find the best tag for a text node by walking up the DOM */
function resolveTag(el: Element): string {
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    const tag = cur.tagName;
    if (tag === "PRE" || tag === "CODE" || tag === "A" ||
        tag === "H1" || tag === "H2" || tag === "H3" ||
        tag === "H4" || tag === "H5" || tag === "H6" ||
        tag === "LI" || tag === "TD" || tag === "TH" ||
        tag === "BLOCKQUOTE" || tag === "LABEL" ||
        tag === "BUTTON" || tag === "FIGCAPTION") {
      return tag;
    }
    cur = cur.parentElement;
  }
  return el.tagName || "BODY";
}

// -- Element collection --

function collectHeadings(): TaggedLine[] {
  if (cache.headings) return cache.headings;
  const lines: TaggedLine[] = [];
  const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
  for (const heading of headings) {
    const el = heading as HTMLElement;
    if (!isVisible(el)) continue;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length > 0) {
      lines.push({ text, lower: text.toLowerCase(), tag: el.tagName, nodeRef: new WeakRef(el) });
    }
  }
  cache.headings = lines;
  return lines;
}

function collectCode(): TaggedLine[] {
  if (cache.code) return cache.code;
  const lines: TaggedLine[] = [];
  const codeEls = document.querySelectorAll("pre, code");
  for (const codeEl of codeEls) {
    const el = codeEl as HTMLElement;
    if (!isVisible(el)) continue;
    if (el.tagName === "CODE" && el.parentElement?.tagName === "PRE") continue;

    if (el.tagName === "PRE") {
      const raw = el.textContent || "";
      const splitLines = raw.split("\n");
      for (const line of splitLines) {
        const trimmed = line.replace(/\s+/g, " ").trim();
        if (trimmed.length > 0) {
          lines.push({ text: trimmed, lower: trimmed.toLowerCase(), tag: "PRE", nodeRef: new WeakRef(el) });
        }
      }
    } else {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        lines.push({ text, lower: text.toLowerCase(), tag: "CODE", nodeRef: new WeakRef(el) });
      }
    }
  }
  cache.code = lines;
  return lines;
}

function collectLinks(): TaggedLine[] {
  if (cache.links) return cache.links;
  const lines: TaggedLine[] = [];
  const links = document.querySelectorAll("a[href]");
  for (const link of links) {
    const el = link as HTMLElement;
    if (!isVisible(el)) continue;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length > 0) {
      lines.push({
        text, lower: text.toLowerCase(), tag: "A",
        nodeRef: new WeakRef(el),
        href: (el as HTMLAnchorElement).href || undefined,
      });
    }
  }
  cache.links = lines;
  return lines;
}

/** Collect all visible text nodes, tagged with their source element.
 *  <pre> blocks are split into individual lines. */
function collectAll(): TaggedLine[] {
  if (cache.all) return cache.all;
  const lines: TaggedLine[] = [];

  // First collect pre blocks split by line
  const preEls = document.querySelectorAll("pre");
  const preSet = new Set<Node>();
  for (const pre of preEls) {
    if (!isVisible(pre as HTMLElement)) continue;
    preSet.add(pre);
    const raw = pre.textContent || "";
    const splitLines = raw.split("\n");
    for (const line of splitLines) {
      const trimmed = line.replace(/\s+/g, " ").trim();
      if (trimmed.length > 0) {
        lines.push({ text: trimmed, lower: trimmed.toLowerCase(), tag: "PRE", nodeRef: new WeakRef(pre) });
      }
    }
  }

  // Then walk all text nodes, skipping those inside <pre>
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Node): number {
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
        let ancestor: Element | null = el;
        while (ancestor) {
          if (preSet.has(ancestor)) return NodeFilter.FILTER_REJECT;
          ancestor = ancestor.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const raw = node.textContent;
    if (!raw || raw.length === 0) continue;
    const text = raw.replace(/\s+/g, " ").trim();
    if (text.length > 0) {
      const tag = resolveTag(node.parentElement!);
      lines.push({ text, lower: text.toLowerCase(), tag, nodeRef: new WeakRef(node) });
    }
  }

  cache.all = lines;
  return lines;
}

/** Collect visible tagged lines based on active filters.
 *  Empty filters = all visible text. Multiple filters = union. */
function collectLines(filters: SearchFilter[]): TaggedLine[] {
  if (filters.length === 0) return collectAll();

  // Single filter — return cached array directly
  if (filters.length === 1) {
    switch (filters[0]) {
      case "code": return collectCode();
      case "headings": return collectHeadings();
      case "links": return collectLinks();
    }
  }

  // Multiple filters — union (collected arrays are cached individually)
  const lines: TaggedLine[] = [];
  for (const filter of filters) {
    switch (filter) {
      case "code":     lines.push(...collectCode());     break;
      case "headings": lines.push(...collectHeadings());  break;
      case "links":    lines.push(...collectLinks());     break;
    }
  }
  return lines;
}

// -- Public API --

/** Extract all visible text nodes as lines (untagged, for getPageContent) */
export function getVisibleText(): string[] {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
  );
  const lines: string[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text && text.length > 0) {
      lines.push(text);
    }
  }
  return lines;
}

export function getPageContent(): PageContent {
  const lines = getVisibleText();
  return { text: lines.join("\n"), lines };
}

/** Search page content with fuzzy scoring and combinable filters.
 *  Returns results sorted by match quality (best first) with context. */
export function grepPage(query: string, filters: SearchFilter[] = []): GrepResult[] {
  if (!query || query.length === 0) return [];

  const lowerQuery = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (lowerQuery.length === 0) return [];

  const allLines = collectLines(filters);

  // Score all lines and collect matches
  const scored: { idx: number; score: number; line: TaggedLine }[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (seen.has(line.text)) continue;

    const score = fuzzyMatch(lowerQuery, line.lower);
    if (score === null) continue;

    seen.add(line.text);
    scored.push({ idx: i, score, line });

    // Early exit: stop collecting after we have enough to fill results
    // with a buffer for sorting (collect 3x to get good top-N)
    if (scored.length >= MAX_RESULTS * 3) break;
  }

  // Sort by score descending (best matches first)
  scored.sort((a, b) => b.score - a.score);

  // Build results with context
  const results: GrepResult[] = [];
  const limit = Math.min(scored.length, MAX_RESULTS);

  for (let i = 0; i < limit; i++) {
    const { idx, score, line } = scored[i];

    // Flat context (fallback)
    const start = Math.max(0, idx - CONTEXT_LINES);
    const end = Math.min(allLines.length, idx + CONTEXT_LINES + 1);
    const context = allLines.slice(start, end).map((l) => l.text);

    // DOM-aware context — pull from same parent element when nodeRef is available
    const node = line.nodeRef?.deref();
    let domContext: string[] | undefined;
    let ancestorHeading: string | undefined;
    let href: string | undefined = line.href;

    if (node) {
      domContext = getDomContext(node, line.text, line.tag);
      ancestorHeading = findAncestorHeading(node);
      if (!href && line.tag === "A") href = findHref(node);
    }

    results.push({
      lineNumber: idx + 1,
      text: line.text,
      tag: line.tag,
      score,
      context,
      nodeRef: line.nodeRef,
      domContext,
      ancestorHeading,
      href,
    });
  }

  return results;
}
