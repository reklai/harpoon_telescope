// Background script — central hub for harpoon state, grep coordination,
// command handling, and message routing between content scripts.

import browser, { Tabs } from "webextension-polyfill";
import { MAX_HARPOON_SLOTS, loadKeybindings, saveKeybindings } from "./lib/keybindings";
import { recordFrecencyVisit, getFrecencyList, removeFrecencyEntry } from "./lib/frecency";
import { HarpoonState, sessionSave, sessionList, sessionLoad, sessionDelete } from "./lib/sessions";

// -- Harpoon State --

let harpoonList: HarpoonEntry[] = [];
let harpoonLoaded = false;

/** Ensure harpoon state is loaded from storage (safe to call multiple times) */
async function ensureHarpoonLoaded(): Promise<void> {
  if (!harpoonLoaded) {
    const data = await browser.storage.local.get("harpoonList");
    harpoonList = (data.harpoonList as HarpoonEntry[]) || [];
    harpoonLoaded = true;
  }
}

async function saveHarpoon(): Promise<void> {
  await browser.storage.local.set({ harpoonList });
}

/** Mark entries whose tabs no longer exist as closed, then re-compact slot numbers */
async function reconcileHarpoon(): Promise<void> {
  await ensureHarpoonLoaded();
  const tabs = await browser.tabs.query({});
  const tabIds = new Set(tabs.map((t) => t.id));
  for (const entry of harpoonList) {
    entry.closed = !tabIds.has(entry.tabId);
  }
  recompactSlots();
  await saveHarpoon();
}

/** Re-number slots sequentially 1..N after any list mutation */
function recompactSlots(): void {
  harpoonList.forEach((entry, i) => {
    entry.slot = i + 1;
  });
}

// State accessor for session module
const harpoonState: HarpoonState = {
  getList: () => harpoonList,
  setList: (list) => { harpoonList = list; },
  recompactSlots,
  save: saveHarpoon,
  ensureLoaded: ensureHarpoonLoaded,
};

// -- Harpoon Actions --

async function harpoonAdd(
  tab: Tabs.Tab,
): Promise<{ ok: boolean; reason?: string; slot?: number }> {
  await reconcileHarpoon();
  if (harpoonList.length >= MAX_HARPOON_SLOTS) {
    try {
      await browser.tabs.sendMessage(tab.id!, {
        type: "HARPOON_FULL_FEEDBACK",
        max: MAX_HARPOON_SLOTS,
      });
    } catch (_) {
      // Silent — toast is non-critical
    }
    return { ok: false, reason: `Harpoon list is full (max ${MAX_HARPOON_SLOTS}).` };
  }
  // Check by tabId first, then by URL (catches closed entries for same page)
  const existing = harpoonList.find(
    (e) => e.tabId === tab.id || e.url === tab.url,
  );
  if (existing) {
    // If it was a closed entry for the same URL, revive it with current tab
    if (existing.closed && existing.url === tab.url) {
      existing.tabId = tab.id!;
      existing.closed = false;
      existing.title = tab.title || existing.title;
      await saveHarpoon();
    }
    try {
      await browser.tabs.sendMessage(tab.id!, {
        type: "HARPOON_ADDED_FEEDBACK",
        slot: existing.slot,
        title: tab.title,
        alreadyAdded: true,
      });
    } catch (_) {
      // Silent — toast is non-critical
    }
    return { ok: false, reason: "Tab already in Harpoon list." };
  }

  // Capture current scroll position from the content script
  let scrollX = 0;
  let scrollY = 0;
  try {
    const response = (await browser.tabs.sendMessage(tab.id!, {
      type: "GET_SCROLL",
    })) as ScrollData;
    scrollX = response.scrollX || 0;
    scrollY = response.scrollY || 0;
  } catch (_) {
    // Content script may not be loaded on restricted pages
  }

  const slot = harpoonList.length + 1;
  harpoonList.push({
    tabId: tab.id!,
    url: tab.url || "",
    title: tab.title || "",
    scrollX,
    scrollY,
    slot,
  });
  await saveHarpoon();

  // Show "Added" toast via content script
  try {
    await browser.tabs.sendMessage(tab.id!, {
      type: "HARPOON_ADDED_FEEDBACK",
      slot,
      title: tab.title,
    });
  } catch (_) {
    // Silent — toast is non-critical
  }
  return { ok: true, slot };
}

async function harpoonRemove(tabId: number): Promise<void> {
  await ensureHarpoonLoaded();
  harpoonList = harpoonList.filter((e) => e.tabId !== tabId);
  recompactSlots();
  await saveHarpoon();
}

/** Save current scroll, activate target tab, and restore its scroll position.
 *  If the tab was closed, re-open it from the stored URL. */
async function harpoonJump(slot: number): Promise<void> {
  await ensureHarpoonLoaded();
  const entry = harpoonList.find((e) => e.slot === slot);
  if (!entry) return;

  // Tab was previously closed — re-open it
  if (entry.closed) {
    await saveCurrentTabScroll();
    try {
      const newTab = await browser.tabs.create({ url: entry.url, active: true });
      entry.tabId = newTab.id!;
      entry.closed = false;
      await saveHarpoon();
      // Wait for tab to finish loading, then restore scroll
      const onUpdated = (tabId: number, info: Tabs.OnUpdatedChangeInfoType) => {
        if (tabId === newTab.id && info.status === "complete") {
          browser.tabs.onUpdated.removeListener(onUpdated);
          browser.tabs
            .sendMessage(newTab.id!, {
              type: "SET_SCROLL",
              scrollX: entry.scrollX,
              scrollY: entry.scrollY,
            })
            .catch(() => {});
        }
      };
      browser.tabs.onUpdated.addListener(onUpdated);
      // Safety timeout: remove listener after 10s in case tab never completes
      setTimeout(() => browser.tabs.onUpdated.removeListener(onUpdated), 10000);
    } catch (_) {
      // URL may be restricted — remove the entry
      harpoonList = harpoonList.filter((e) => e.slot !== slot);
      recompactSlots();
      await saveHarpoon();
    }
    return;
  }

  // Tab is still open — switch to it
  const [, switchResult] = await Promise.all([
    saveCurrentTabScroll(),
    browser.tabs.update(entry.tabId, { active: true }).catch(() => null),
  ]);

  // Tab was closed between reconcile and jump — mark closed and retry
  if (!switchResult) {
    entry.closed = true;
    await saveHarpoon();
    await harpoonJump(slot);
    return;
  }

  // Fire-and-forget scroll restore
  browser.tabs
    .sendMessage(entry.tabId, {
      type: "SET_SCROLL",
      scrollX: entry.scrollX,
      scrollY: entry.scrollY,
    })
    .catch(() => {});
}

/** Persist scroll position of the currently active harpooned tab */
async function saveCurrentTabScroll(): Promise<void> {
  await ensureHarpoonLoaded();
  const [activeTab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab) return;
  const entry = harpoonList.find((e) => e.tabId === activeTab.id);
  if (!entry || entry.closed) return;
  try {
    const response = (await browser.tabs.sendMessage(activeTab.id!, {
      type: "GET_SCROLL",
    })) as ScrollData;
    entry.scrollX = response.scrollX || 0;
    entry.scrollY = response.scrollY || 0;
    await saveHarpoon();
  } catch (_) {
    // Content script unavailable
  }
}

// Track the previously active tab so onActivated only saves scroll for it
let lastActiveTabId: number | null = null;

// -- Tab Lifecycle --

browser.tabs.onRemoved.addListener(async (tabId: number) => {
  await ensureHarpoonLoaded();
  const entry = harpoonList.find((e) => e.tabId === tabId);
  if (entry) {
    entry.closed = true;
    await saveHarpoon();
  }

  // Clean frecency data for closed tabs
  await removeFrecencyEntry(tabId);
});

// Debounced save for onUpdated — coalesces rapid title/URL changes (SPAs)
let onUpdatedSaveTimer: ReturnType<typeof setTimeout> | null = null;

browser.tabs.onUpdated.addListener(
  async (tabId: number, changeInfo: Tabs.OnUpdatedChangeInfoType) => {
    await ensureHarpoonLoaded();
    const entry = harpoonList.find((e) => e.tabId === tabId);
    if (entry) {
      let changed = false;
      if (changeInfo.url) { entry.url = changeInfo.url; changed = true; }
      if (changeInfo.title) { entry.title = changeInfo.title; changed = true; }
      if (changed) {
        if (onUpdatedSaveTimer) clearTimeout(onUpdatedSaveTimer);
        onUpdatedSaveTimer = setTimeout(() => {
          onUpdatedSaveTimer = null;
          saveHarpoon();
        }, 500);
      }
    }
  },
);

// Save scroll position for previously active harpooned tab + record frecency
browser.tabs.onActivated.addListener(
  async (activeInfo: Tabs.OnActivatedActiveInfoType) => {
    const prevTabId = lastActiveTabId;
    lastActiveTabId = activeInfo.tabId;

    // Record frecency for the newly activated tab
    try {
      const tab = await browser.tabs.get(activeInfo.tabId);
      await recordFrecencyVisit(tab);
    } catch (_) {
      // Tab may have been closed between activation and get
    }

    if (prevTabId === null) return;

    await ensureHarpoonLoaded();
    const entry = harpoonList.find((e) => e.tabId === prevTabId);
    if (!entry || entry.closed) return;

    try {
      const response = (await browser.tabs.sendMessage(prevTabId, {
        type: "GET_SCROLL",
      })) as ScrollData;
      entry.scrollX = response.scrollX || 0;
      entry.scrollY = response.scrollY || 0;
      await saveHarpoon();
    } catch (_) {
      // Tab may not have content script
    }
  },
);

// -- Telescope: Grep --

async function grepCurrentTab(query: string, filters: SearchFilter[] = []): Promise<GrepResult[]> {
  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab) return [];
  try {
    return (await browser.tabs.sendMessage(tab.id!, {
      type: "GREP",
      query,
      filters,
    })) as GrepResult[];
  } catch (_) {
    return [];
  }
}

async function getPageContent(
  tabId: number,
): Promise<PageContent> {
  try {
    return (await browser.tabs.sendMessage(tabId, {
      type: "GET_CONTENT",
    })) as PageContent;
  } catch (_) {
    return { text: "", lines: [] };
  }
}

// -- Bookmarks --

// Bookmark usage tracking — persists visit counts per URL across sessions
let bookmarkUsageMap: Record<string, BookmarkUsage> = {};
let bookmarkUsageLoaded = false;

async function ensureBookmarkUsageLoaded(): Promise<void> {
  if (!bookmarkUsageLoaded) {
    const data = await browser.storage.local.get("bookmarkUsage");
    bookmarkUsageMap = (data.bookmarkUsage as Record<string, BookmarkUsage>) || {};
    bookmarkUsageLoaded = true;
  }
}

async function saveBookmarkUsage(): Promise<void> {
  await browser.storage.local.set({ bookmarkUsage: bookmarkUsageMap });
}

/** Compute usage score: visitCount weighted by recency (Mozilla-style buckets) */
function computeBookmarkUsageScore(usage: BookmarkUsage): number {
  if (!usage) return 0;
  const ageMs = Date.now() - usage.lastVisit;
  const ageMin = ageMs / 60000;
  let weight: number;
  if (ageMin < 240) weight = 100;         // < 4 hours
  else if (ageMin < 1440) weight = 70;    // < 1 day
  else if (ageMin < 10080) weight = 50;   // < 1 week
  else if (ageMin < 43200) weight = 30;   // < 1 month
  else weight = 10;
  return Math.round(usage.visitCount * weight);
}

async function recordBookmarkVisit(url: string): Promise<void> {
  await ensureBookmarkUsageLoaded();
  const existing = bookmarkUsageMap[url];
  if (existing) {
    existing.visitCount++;
    existing.lastVisit = Date.now();
  } else {
    bookmarkUsageMap[url] = { visitCount: 1, lastVisit: Date.now() };
  }
  await saveBookmarkUsage();
}

/** Recursively collect all bookmark entries (not folders/separators) */
async function getBookmarkList(): Promise<BookmarkEntry[]> {
  await ensureBookmarkUsageLoaded();
  const tree = await browser.bookmarks.getTree();
  const results: BookmarkEntry[] = [];

  function walk(
    nodes: browser.Bookmarks.BookmarkTreeNode[],
    parentTitle?: string,
    parentPath?: string,
    parentId?: string,
  ): void {
    for (const node of nodes) {
      if (node.url) {
        const usage = bookmarkUsageMap[node.url];
        results.push({
          id: node.id,
          url: node.url,
          title: node.title || "",
          dateAdded: node.dateAdded,
          parentId: parentId,
          parentTitle: parentTitle,
          folderPath: parentPath,
          usageScore: usage ? computeBookmarkUsageScore(usage) : 0,
        });
      }
      if (node.children) {
        const newTitle = node.title || parentTitle;
        const newPath = node.title
          ? (parentPath ? parentPath + " \u203a " + node.title : node.title)
          : parentPath;
        walk(node.children, newTitle, newPath, node.id);
      }
    }
  }

  walk(tree);
  // Sort by usage score first, then by date added for unvisited
  results.sort((a, b) => {
    if ((a.usageScore || 0) !== (b.usageScore || 0)) {
      return (b.usageScore || 0) - (a.usageScore || 0);
    }
    return (b.dateAdded || 0) - (a.dateAdded || 0);
  });
  return results;
}

/** Recursively collect bookmark folders for the folder picker UI */
interface BookmarkFolder {
  id: string;
  title: string;
  depth: number;
  children: BookmarkFolder[];
}

async function getBookmarkFolders(): Promise<BookmarkFolder[]> {
  const tree = await browser.bookmarks.getTree();
  const folders: BookmarkFolder[] = [];

  function walk(nodes: browser.Bookmarks.BookmarkTreeNode[], depth: number): void {
    for (const node of nodes) {
      // A folder has children array and no url
      if (!node.url && node.children) {
        const folder: BookmarkFolder = {
          id: node.id,
          title: node.title || "(root)",
          depth,
          children: [],
        };
        // Recurse into sub-folders
        const subFolders: BookmarkFolder[] = [];
        for (const child of node.children) {
          if (!child.url && child.children) {
            walkInto(child, depth + 1, subFolders);
          }
        }
        folder.children = subFolders;
        folders.push(folder);
      }
    }
  }

  function walkInto(node: browser.Bookmarks.BookmarkTreeNode, depth: number, target: BookmarkFolder[]): void {
    const folder: BookmarkFolder = {
      id: node.id,
      title: node.title || "(unnamed)",
      depth,
      children: [],
    };
    if (node.children) {
      for (const child of node.children) {
        if (!child.url && child.children) {
          walkInto(child, depth + 1, folder.children);
        }
      }
    }
    target.push(folder);
  }

  walk(tree, 0);
  return folders;
}

// -- Command Handlers --

browser.commands.onCommand.addListener(async (command: string) => {
  const [activeTab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab) return;

  switch (command) {
    case "open-telescope-current":
      try {
        await browser.tabs.sendMessage(activeTab.id!, {
          type: "OPEN_TELESCOPE",
        });
      } catch (_) {}
      break;
    case "open-harpoon":
      try {
        await browser.tabs.sendMessage(activeTab.id!, {
          type: "OPEN_HARPOON_OVERLAY",
        });
      } catch (_) {}
      break;
    case "harpoon-add":
      await harpoonAdd(activeTab);
      break;
    case "harpoon-tab-1":
      await harpoonJump(1);
      break;
    case "harpoon-tab-2":
      await harpoonJump(2);
      break;
    case "harpoon-tab-3":
      await harpoonJump(3);
      break;
    case "harpoon-tab-4":
      await harpoonJump(4);
      break;
  }
});

// -- Message Router --

browser.runtime.onMessage.addListener(
  async (msg: unknown): Promise<unknown> => {
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case "GREP_CURRENT":
        return await grepCurrentTab(m.query as string, (m.filters as SearchFilter[]) || []);
      case "GET_PAGE_CONTENT":
        return await getPageContent(m.tabId as number);
      case "HARPOON_ADD": {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        return await harpoonAdd(tab);
      }
      case "HARPOON_REMOVE":
        await harpoonRemove(m.tabId as number);
        return { ok: true };
      case "HARPOON_LIST":
        await reconcileHarpoon();
        return harpoonList;
      case "HARPOON_JUMP":
        await harpoonJump(m.slot as number);
        return { ok: true };
      case "HARPOON_CYCLE": {
        await ensureHarpoonLoaded();
        if (harpoonList.length === 0) return { ok: false };
        const [curTab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        const curIdx = curTab
          ? harpoonList.findIndex((e) => e.tabId === curTab.id)
          : -1;
        const dir = m.direction as "prev" | "next";
        let targetIdx: number;
        if (curIdx === -1) {
          // Current tab not in harpoon — jump to first or last
          targetIdx = dir === "next" ? 0 : harpoonList.length - 1;
        } else {
          targetIdx =
            dir === "next"
              ? (curIdx + 1) % harpoonList.length
              : (curIdx - 1 + harpoonList.length) % harpoonList.length;
        }
        await harpoonJump(harpoonList[targetIdx].slot);
        return { ok: true };
      }
      case "HARPOON_SAVE_SCROLL":
        await saveCurrentTabScroll();
        return { ok: true };
      case "HARPOON_REORDER":
        await ensureHarpoonLoaded();
        harpoonList = m.list as HarpoonEntry[];
        recompactSlots();
        await saveHarpoon();
        return { ok: true };
      case "GET_CURRENT_TAB": {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        return tab || null;
      }
      case "GET_KEYBINDINGS":
        return await loadKeybindings();
      case "SAVE_KEYBINDINGS":
        await saveKeybindings(m.config as KeybindingsConfig);
        return { ok: true };
      case "SWITCH_TO_TAB":
        try {
          await browser.tabs.update(m.tabId as number, { active: true });
        } catch (_) {}
        return { ok: true };
      case "FRECENCY_LIST":
        return await getFrecencyList();
      case "BOOKMARK_LIST":
        return await getBookmarkList();
      case "HISTORY_LIST": {
        const maxResults = (m.maxResults as number) || 500;
        const text = (m.text as string) || "";
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
        // Sort by last visit time (most recent first)
        entries.sort((a, b) => b.lastVisitTime - a.lastVisitTime);
        return entries;
      }
      case "OPEN_BOOKMARK_TAB": {
        const url = m.url as string;
        try {
          // Check if URL is already open in current window — switch to it
          const tabs = await browser.tabs.query({ currentWindow: true });
          const existing = tabs.find((t) => t.url === url);
          if (existing && existing.id) {
            await browser.tabs.update(existing.id, { active: true });
          } else {
            await browser.tabs.create({ url, active: true });
          }
          await recordBookmarkVisit(url);
        } catch (_) {}
        return { ok: true };
      }
      case "BOOKMARK_ADD": {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) return { ok: false, reason: "No active tab" };
        try {
          const opts: browser.Bookmarks.CreateDetails = {
            url: tab.url,
            title: tab.title || tab.url,
          };
          // Optional folder placement — if parentId is provided, save into that folder
          if (m.parentId) {
            opts.parentId = m.parentId as string;
          }
          const created = await browser.bookmarks.create(opts);
          return { ok: true, id: created.id, title: tab.title };
        } catch (_) {
          return { ok: false, reason: "Failed to create bookmark" };
        }
      }
      case "BOOKMARK_REMOVE": {
        try {
          await browser.bookmarks.remove(m.id as string);
          // Clean up usage data for removed bookmark
          if (m.url) {
            await ensureBookmarkUsageLoaded();
            delete bookmarkUsageMap[m.url as string];
            await saveBookmarkUsage();
          }
          return { ok: true };
        } catch (_) {
          return { ok: false, reason: "Failed to remove bookmark" };
        }
      }
      case "BOOKMARK_FOLDERS":
        return await getBookmarkFolders();
      case "BOOKMARK_CREATE_FOLDER": {
        try {
          const opts: browser.Bookmarks.CreateDetails = {
            title: m.title as string,
          };
          if (m.parentId) {
            opts.parentId = m.parentId as string;
          }
          await browser.bookmarks.create(opts);
          return { ok: true, title: m.title };
        } catch (_) {
          return { ok: false, reason: "Failed to create folder" };
        }
      }
      case "BOOKMARK_MOVE": {
        try {
          const dest: { parentId?: string; index?: number } = {};
          if (m.parentId) dest.parentId = m.parentId as string;
          await browser.bookmarks.move(m.id as string, dest);
          return { ok: true };
        } catch (_) {
          return { ok: false, reason: "Failed to move bookmark" };
        }
      }
      case "SESSION_SAVE":
        return await sessionSave(harpoonState, m.name as string);
      case "SESSION_LIST":
        return await sessionList();
      case "SESSION_LOAD":
        return await sessionLoad(harpoonState, m.name as string);
      case "SESSION_DELETE":
        return await sessionDelete(m.name as string);
      default:
        return null;
    }
  },
);

// -- Init --
// Eagerly load harpoon state and capture the initial active tab (non-blocking)
ensureHarpoonLoaded();
browser.tabs
  .query({ active: true, currentWindow: true })
  .then(([tab]) => {
    if (tab?.id) lastActiveTabId = tab.id;
  })
  .catch(() => {});

// -- Session restore prompt on browser startup --
browser.runtime.onStartup.addListener(async () => {
  const stored = await browser.storage.local.get("harpoonSessions");
  const sessions = (stored.harpoonSessions as HarpoonSession[]) || [];
  if (sessions.length === 0) return;

  // Clear stale harpoon state from previous browser session
  // (all tabs have new IDs after restart)
  await ensureHarpoonLoaded();
  harpoonList = [];
  await saveHarpoon();

  // Wait for a tab to be ready, then prompt for session restore
  // Retry a few times since tabs may still be loading
  let attempts = 0;
  const tryPrompt = async () => {
    attempts++;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      if (attempts < 5) setTimeout(tryPrompt, 1000);
      return;
    }
    try {
      await browser.tabs.sendMessage(tab.id, {
        type: "SHOW_SESSION_RESTORE",
      });
    } catch (_) {
      // Content script not ready — retry
      if (attempts < 5) setTimeout(tryPrompt, 1000);
    }
  };
  // Delay initial attempt to let tabs load
  setTimeout(tryPrompt, 1500);
});
