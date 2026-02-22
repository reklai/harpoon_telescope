export const CONTEXT_LINES = 5;

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

const CONTEXT_BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "BLOCKQUOTE", "LI", "TD", "TH",
  "FIGCAPTION", "DETAILS", "SUMMARY", "ASIDE", "MAIN", "NAV", "HEADER", "FOOTER",
]);

export function isVisible(el: HTMLElement): boolean {
  if (el === document.body) return true;
  if (!el.offsetParent && el.style.position !== "fixed" && el.style.position !== "sticky") {
    return false;
  }
  return true;
}

export function findAncestorHeading(node: Node): string | undefined {
  let el: Element | null = node instanceof Element ? node : node.parentElement;
  if (!el) return undefined;

  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    if (HEADING_TAGS.has(cur.tagName)) {
      return (cur.textContent || "").replace(/\s+/g, " ").trim() || undefined;
    }
    cur = cur.parentElement;
  }

  cur = el;
  while (cur && cur !== document.body) {
    let sibling = cur.previousElementSibling;
    while (sibling) {
      if (HEADING_TAGS.has(sibling.tagName)) {
        return (sibling.textContent || "").replace(/\s+/g, " ").trim() || undefined;
      }
      const headings = sibling.querySelectorAll("h1, h2, h3, h4, h5, h6");
      if (headings.length > 0) {
        const last = headings[headings.length - 1];
        return (last.textContent || "").replace(/\s+/g, " ").trim() || undefined;
      }
      sibling = sibling.previousElementSibling;
    }
    cur = cur.parentElement;
  }

  return undefined;
}

export function findHref(node: Node): string | undefined {
  let el: Element | null = node instanceof Element ? node : node.parentElement;
  while (el && el !== document.body) {
    if (el.tagName === "A") {
      return (el as HTMLAnchorElement).href || undefined;
    }
    el = el.parentElement;
  }
  return undefined;
}

export function getDomContext(node: Node, matchText: string, tag: string): string[] {
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return [matchText];

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
        return lines.slice(start, end).map((line) => line.replace(/\t/g, "  "));
      }
      return lines.slice(0, CONTEXT_LINES * 2 + 1).map((line) => line.replace(/\t/g, "  "));
    }
  }

  let block: Element | null = el;
  while (block && block !== document.body) {
    if (CONTEXT_BLOCK_TAGS.has(block.tagName) || HEADING_TAGS.has(block.tagName)) break;
    block = block.parentElement;
  }
  if (!block || block === document.body) block = el;

  const blockText = (block.textContent || "").replace(/\s+/g, " ").trim();
  if (blockText.length <= 200) return [blockText];

  const sentences = blockText.split(/(?<=[.!?])\s+/);
  const matchLower = matchText.toLowerCase();
  let matchSentenceIndex = -1;
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].toLowerCase().includes(matchLower)) {
      matchSentenceIndex = i;
      break;
    }
  }

  if (matchSentenceIndex >= 0) {
    const start = Math.max(0, matchSentenceIndex - 2);
    const end = Math.min(sentences.length, matchSentenceIndex + 3);
    return sentences.slice(start, end);
  }

  return [blockText.slice(0, 300)];
}

export function resolveTag(el: Element): string {
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    const tag = cur.tagName;
    if (
      tag === "PRE"
      || tag === "CODE"
      || tag === "A"
      || tag === "H1"
      || tag === "H2"
      || tag === "H3"
      || tag === "H4"
      || tag === "H5"
      || tag === "H6"
      || tag === "LI"
      || tag === "TD"
      || tag === "TH"
      || tag === "BLOCKQUOTE"
      || tag === "LABEL"
      || tag === "BUTTON"
      || tag === "FIGCAPTION"
    ) {
      return tag;
    }
    cur = cur.parentElement;
  }
  return el.tagName || "BODY";
}
