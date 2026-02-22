import browser from "webextension-polyfill";

export async function grepCurrentTab(
  query: string,
  filters: SearchFilter[] = [],
): Promise<GrepResult[]> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return [];

  try {
    return (await browser.tabs.sendMessage(tab.id, {
      type: "GREP",
      query,
      filters,
    })) as GrepResult[];
  } catch (_) {
    return [];
  }
}

export async function getPageContent(tabId: number): Promise<PageContent> {
  try {
    return (await browser.tabs.sendMessage(tabId, {
      type: "GET_CONTENT",
    })) as PageContent;
  } catch (_) {
    return { text: "", lines: [] };
  }
}
