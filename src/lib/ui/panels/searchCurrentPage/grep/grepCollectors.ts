import { getLineCache } from "./grepCache";
import { isVisible, resolveTag } from "./grepDom";
import { TaggedLine } from "./grepTypes";

function collectHeadings(): TaggedLine[] {
  const cache = getLineCache();
  if (cache.headings) return cache.headings;

  const lines: TaggedLine[] = [];
  const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
  for (const heading of headings) {
    const el = heading as HTMLElement;
    if (!isVisible(el)) continue;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push({ text, lower: text.toLowerCase(), tag: el.tagName, nodeRef: new WeakRef(el) });
  }

  cache.headings = lines;
  return lines;
}

function collectCode(): TaggedLine[] {
  const cache = getLineCache();
  if (cache.code) return cache.code;

  const lines: TaggedLine[] = [];
  const codeElements = document.querySelectorAll("pre, code");
  for (const codeElement of codeElements) {
    const el = codeElement as HTMLElement;
    if (!isVisible(el)) continue;
    if (el.tagName === "CODE" && el.parentElement?.tagName === "PRE") continue;

    if (el.tagName === "PRE") {
      const raw = el.textContent || "";
      for (const line of raw.split("\n")) {
        const trimmed = line.replace(/\s+/g, " ").trim();
        if (!trimmed) continue;
        lines.push({ text: trimmed, lower: trimmed.toLowerCase(), tag: "PRE", nodeRef: new WeakRef(el) });
      }
      continue;
    }

    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push({ text, lower: text.toLowerCase(), tag: "CODE", nodeRef: new WeakRef(el) });
  }

  cache.code = lines;
  return lines;
}

function collectLinks(): TaggedLine[] {
  const cache = getLineCache();
  if (cache.links) return cache.links;

  const lines: TaggedLine[] = [];
  const links = document.querySelectorAll("a[href]");
  for (const link of links) {
    const el = link as HTMLElement;
    if (!isVisible(el)) continue;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push({
      text,
      lower: text.toLowerCase(),
      tag: "A",
      nodeRef: new WeakRef(el),
      href: (el as HTMLAnchorElement).href || undefined,
    });
  }

  cache.links = lines;
  return lines;
}

function collectImages(): TaggedLine[] {
  const cache = getLineCache();
  if (cache.images) return cache.images;

  const lines: TaggedLine[] = [];
  const images = document.querySelectorAll("img");
  for (const image of images) {
    const el = image as HTMLImageElement;
    if (!isVisible(el)) continue;
    const text = el.alt?.trim()
      || el.title?.trim()
      || (el.src ? el.src.split("/").pop()?.split("?")[0] || "" : "").trim();
    if (!text) continue;
    lines.push({ text, lower: text.toLowerCase(), tag: "IMG", nodeRef: new WeakRef(el) });
  }

  cache.images = lines;
  return lines;
}

function collectAll(): TaggedLine[] {
  const cache = getLineCache();
  if (cache.all) return cache.all;

  const lines: TaggedLine[] = [];

  const preElements = document.querySelectorAll("pre");
  const preSet = new Set<Node>();
  for (const pre of preElements) {
    if (!isVisible(pre as HTMLElement)) continue;
    preSet.add(pre);
    const raw = pre.textContent || "";
    for (const line of raw.split("\n")) {
      const trimmed = line.replace(/\s+/g, " ").trim();
      if (!trimmed) continue;
      lines.push({ text: trimmed, lower: trimmed.toLowerCase(), tag: "PRE", nodeRef: new WeakRef(pre) });
    }
  }

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
    if (!raw) continue;
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const tag = resolveTag(node.parentElement!);
    lines.push({ text, lower: text.toLowerCase(), tag, nodeRef: new WeakRef(node) });
  }

  cache.all = lines;
  return lines;
}

export function collectLines(filters: SearchFilter[]): TaggedLine[] {
  if (filters.length === 0) return collectAll();

  if (filters.length === 1) {
    switch (filters[0]) {
      case "code": return collectCode();
      case "headings": return collectHeadings();
      case "links": return collectLinks();
      case "images": return collectImages();
    }
  }

  const seen = new Set<TaggedLine>();
  const lines: TaggedLine[] = [];
  for (const filter of filters) {
    let source: TaggedLine[];
    switch (filter) {
      case "code": source = collectCode(); break;
      case "headings": source = collectHeadings(); break;
      case "links": source = collectLinks(); break;
      case "images": source = collectImages(); break;
    }

    for (const line of source) {
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }

  return lines;
}

export function getVisibleText(): string[] {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  const lines: string[] = [];

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (!text) continue;
    lines.push(text);
  }

  return lines;
}
