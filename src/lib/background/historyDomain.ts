import browser from "webextension-polyfill";

export async function getHistoryEntries(
  maxResults: number = 500,
  text: string = "",
): Promise<HistoryEntry[]> {
  const items = await browser.history.search({
    text,
    maxResults,
    startTime: 0,
  });

  const entries: HistoryEntry[] = items
    .filter((item) => item.url)
    .map((item) => ({
      url: item.url!,
      title: item.title || "",
      lastVisitTime: item.lastVisitTime || 0,
      visitCount: item.visitCount || 0,
    }));

  entries.sort((a, b) => b.lastVisitTime - a.lastVisitTime);
  return entries;
}
