// Page grep and content extraction.
// Uses a character-by-character fuzzy scoring algorithm (no regex backtracking).
// Supports combinable structural filters (code, headings, links) via SearchFilter[].
// Code blocks (<pre>) are split into individual lines. Each result is tagged
// with its source element type for badge display.
// Lines are cached and invalidated via MutationObserver for near-instant re-search.

import { initLineCache, destroyLineCache } from "./grep/grepCache";
import { collectLines, getVisibleText } from "./grep/grepCollectors";
import { CONTEXT_LINES, findAncestorHeading, findHref, getDomContext } from "./grep/grepDom";
import { fuzzyMatch } from "./grep/grepScoring";

const MAX_RESULTS = 200;

export { initLineCache, destroyLineCache };

export function getPageContent(): PageContent {
  const lines = getVisibleText();
  return { text: lines.join("\n"), lines };
}

/** Search page content with fuzzy scoring and combinable filters.
 *  Returns results sorted by match quality (best first) with context. */
export function grepPage(query: string, filters: SearchFilter[] = []): GrepResult[] {
  if (!query || query.length === 0) return [];

  const lowerQuery = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (!lowerQuery) return [];

  const allLines = collectLines(filters);
  const scored: { idx: number; score: number; line: { text: string; tag: string; nodeRef?: WeakRef<Node>; href?: string } }[] = [];

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const score = fuzzyMatch(lowerQuery, line.lower);
    if (score === null) continue;

    scored.push({ idx: i, score, line });
    if (scored.length >= MAX_RESULTS * 3) break;
  }

  scored.sort((a, b) => b.score - a.score);

  const results: GrepResult[] = [];
  const limit = Math.min(scored.length, MAX_RESULTS);

  for (let i = 0; i < limit; i++) {
    const { idx, score, line } = scored[i];

    const start = Math.max(0, idx - CONTEXT_LINES);
    const end = Math.min(allLines.length, idx + CONTEXT_LINES + 1);
    const context = allLines.slice(start, end).map((candidate) => candidate.text);

    results.push({
      lineNumber: idx + 1,
      text: line.text,
      tag: line.tag,
      score,
      context,
      nodeRef: line.nodeRef,
      href: line.href,
    });
  }

  return results;
}

/** Lazily compute DOM-aware context for a single result (called on preview).
 *  Mutates the result in place to cache the computed fields. */
export function enrichResult(result: GrepResult): void {
  if (result.domContext) return;
  const node = result.nodeRef?.deref();
  if (!node) return;

  result.domContext = getDomContext(node, result.text, result.tag || "");
  result.ancestorHeading = findAncestorHeading(node);
  if (!result.href && result.tag === "A") {
    result.href = findHref(node);
  }
}
