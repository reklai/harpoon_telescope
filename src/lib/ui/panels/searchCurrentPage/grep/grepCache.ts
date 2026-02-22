import { LineCache } from "./grepTypes";

const cache: LineCache = {
  all: null,
  code: null,
  headings: null,
  links: null,
  images: null,
  observer: null,
  invalidateTimer: null,
};

export function getLineCache(): LineCache {
  return cache;
}

export function invalidateCache(): void {
  cache.all = null;
  cache.code = null;
  cache.headings = null;
  cache.links = null;
  cache.images = null;
}

export function initLineCache(): void {
  invalidateCache();
  if (cache.observer) cache.observer.disconnect();
  cache.observer = new MutationObserver(() => {
    if (cache.invalidateTimer) clearTimeout(cache.invalidateTimer);
    cache.invalidateTimer = setTimeout(invalidateCache, 500);
  });
  cache.observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

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
