// Shared utility functions used across content script modules.

/** HTML-escape a string to prevent XSS in innerHTML assignments */
const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const HTML_ESCAPE_RE = /[&<>"']/;
export function escapeHtml(text: string): string {
  if (!HTML_ESCAPE_RE.test(text)) return text;
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

/** Escape special regex characters so user input can be used in RegExp safely */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a case-insensitive fuzzy regex from a space-separated query string */
export function buildFuzzyPattern(query: string): RegExp | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const pattern = terms
    .map((term) =>
      term
        .split("")
        .map((character) => escapeRegex(character))
        .join("[^]*?"),
    )
    .join("[^]*?");
  try {
    return new RegExp(pattern, "i");
  } catch (_) {
    return null;
  }
}

/** Extract hostname from a URL, with fallback to truncated string */
const DOMAIN_CACHE_MAX = 500;
const domainCache = new Map<string, string>();

function cacheDomain(url: string, value: string): string {
  if (domainCache.size >= DOMAIN_CACHE_MAX) {
    const firstKey = domainCache.keys().next().value;
    if (firstKey !== undefined) domainCache.delete(firstKey);
  }
  domainCache.set(url, value);
  return value;
}

export function extractDomain(url: string): string {
  const cached = domainCache.get(url);
  if (cached) return cached;
  try {
    return cacheDomain(url, new URL(url).hostname);
  } catch (_) {
    return cacheDomain(url, url.length > 30 ? url.substring(0, 30) + "\u2026" : url);
  }
}
