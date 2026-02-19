// Frecency tracking — Mozilla-style algorithm for scoring tab visits.
// Self-contained module: manages its own state and storage persistence.

import browser, { Tabs } from "webextension-polyfill";

// In-memory frecency map keyed by tabId, persisted to storage
const MAX_FRECENCY_ENTRIES = 50;
let frecencyMap: Map<number, FrecencyEntry> = new Map();
let frecencyLoaded = false;

export async function ensureFrecencyLoaded(): Promise<void> {
  if (!frecencyLoaded) {
    const data = await browser.storage.local.get("frecencyData");
    const arr = (data.frecencyData as FrecencyEntry[]) || [];
    frecencyMap = new Map(arr.map((e) => [e.tabId, e]));
    frecencyLoaded = true;
  }
}

async function saveFrecency(): Promise<void> {
  await browser.storage.local.set({
    frecencyData: Array.from(frecencyMap.values()),
  });
}

/** Mozilla-style frecency score: visitCount * recencyWeight.
 *  Time-decay buckets: <4min=100, <1hr=70, <1day=50, <1week=30, older=10 */
function computeFrecencyScore(entry: FrecencyEntry): number {
  const age = Date.now() - entry.lastVisit;
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const WEEK = 604_800_000;

  let recencyWeight: number;
  if (age < 4 * MINUTE) recencyWeight = 100;
  else if (age < HOUR) recencyWeight = 70;
  else if (age < DAY) recencyWeight = 50;
  else if (age < WEEK) recencyWeight = 30;
  else recencyWeight = 10;

  return entry.visitCount * recencyWeight;
}

/** Record a tab visit and update its frecency score */
export async function recordFrecencyVisit(tab: Tabs.Tab): Promise<void> {
  await ensureFrecencyLoaded();
  if (!tab.id) return;

  const existing = frecencyMap.get(tab.id);
  if (existing) {
    existing.visitCount++;
    existing.lastVisit = Date.now();
    existing.url = tab.url || existing.url;
    existing.title = tab.title || existing.title;
    existing.frecencyScore = computeFrecencyScore(existing);
  } else {
    const entry: FrecencyEntry = {
      tabId: tab.id,
      url: tab.url || "",
      title: tab.title || "",
      visitCount: 1,
      lastVisit: Date.now(),
      frecencyScore: 100, // first visit = 1 * 100 recency weight
    };
    frecencyMap.set(tab.id, entry);

    // Evict lowest-scored entry if over cap
    if (frecencyMap.size > MAX_FRECENCY_ENTRIES) {
      let lowestId: number | null = null;
      let lowestScore = Infinity;
      for (const [id, e] of frecencyMap) {
        if (e.frecencyScore < lowestScore) {
          lowestScore = e.frecencyScore;
          lowestId = id;
        }
      }
      if (lowestId !== null) frecencyMap.delete(lowestId);
    }
  }
  await saveFrecency();
}

/** Build a frecency-scored list of all open tabs, sorted by score descending */
export async function getFrecencyList(): Promise<FrecencyEntry[]> {
  await ensureFrecencyLoaded();
  const tabs = await browser.tabs.query({ currentWindow: true });
  const tabIds = new Set(tabs.map((t) => t.id));

  // Prune closed tabs from frecency map
  for (const id of frecencyMap.keys()) {
    if (!tabIds.has(id)) frecencyMap.delete(id);
  }

  // Build entries for all open tabs, adding untracked tabs with score 0
  const entries: FrecencyEntry[] = tabs.map((t) => {
    const existing = frecencyMap.get(t.id!);
    if (existing) {
      // Refresh title/url and recompute score
      existing.url = t.url || existing.url;
      existing.title = t.title || existing.title;
      existing.frecencyScore = computeFrecencyScore(existing);
      return { ...existing };
    }
    return {
      tabId: t.id!,
      url: t.url || "",
      title: t.title || "",
      visitCount: 0,
      lastVisit: 0,
      frecencyScore: 0,
    };
  });

  entries.sort((a, b) => b.frecencyScore - a.frecencyScore);
  return entries;
}

/** Remove a tab from the frecency map (call on tab close) */
export async function removeFrecencyEntry(tabId: number): Promise<void> {
  await ensureFrecencyLoaded();
  if (frecencyMap.delete(tabId)) await saveFrecency();
}
