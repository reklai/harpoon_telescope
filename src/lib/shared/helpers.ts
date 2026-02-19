// Shared utility functions used across content script modules.

/** HTML-escape a string to prevent XSS in innerHTML assignments */
const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

/** Escape special regex characters so user input can be used in RegExp safely */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a case-insensitive fuzzy regex from a space-separated query string */
export function buildFuzzyPattern(query: string): RegExp | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const pattern = terms
    .map((t) =>
      t
        .split("")
        .map((c) => escapeRegex(c))
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
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return url.length > 30 ? url.substring(0, 30) + "\u2026" : url;
  }
}
