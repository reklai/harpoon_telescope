// Background script — central hub for tab manager state, grep coordination,
// command handling, and message routing between content scripts.

import browser, { Tabs } from "webextension-polyfill";
import { MAX_TAB_MANAGER_SLOTS, loadKeybindings, saveKeybindings } from "../../lib/shared/keybindings";
import { recordFrecencyVisit, getFrecencyList, removeFrecencyEntry } from "../../lib/shared/frecencyScoring";
import { TabManagerState, sessionSave, sessionList, sessionLoad, sessionDelete, sessionRename, sessionUpdate } from "../../lib/shared/sessions";
import { BackgroundRuntimeMessage } from "../../lib/shared/runtimeMessages";

// -- Tab Manager State --

let tabManagerList: TabManagerEntry[] = [];
let tabManagerLoaded = false;

/** Ensure tab manager state is loaded from storage (safe to call multiple times) */
async function ensureTabManagerLoaded(): Promise<void> {
  if (!tabManagerLoaded) {
    const data = await browser.storage.local.get("tabManagerList");
    tabManagerList = (data.tabManagerList as TabManagerEntry[]) || [];
    tabManagerLoaded = true;
  }
}

async function saveTabManager(): Promise<void> {
  await browser.storage.local.set({ tabManagerList });
}

/** Mark entries whose tabs no longer exist as closed, then re-compact slot numbers */
async function reconcileTabManager(): Promise<void> {
  await ensureTabManagerLoaded();
  const tabs = await browser.tabs.query({});
  const tabIds = new Set(tabs.map((t) => t.id));
  for (const entry of tabManagerList) {
    entry.closed = !tabIds.has(entry.tabId);
  }
  recompactSlots();
  await saveTabManager();
}

/** Re-number slots sequentially 1..N after any list mutation */
function recompactSlots(): void {
  tabManagerList.forEach((entry, i) => {
    entry.slot = i + 1;
  });
}

// State accessor for session module
const tabManagerState: TabManagerState = {
  getList: () => tabManagerList,
  setList: (list) => { tabManagerList = list; },
  recompactSlots,
  save: saveTabManager,
  ensureLoaded: ensureTabManagerLoaded,
  queueScrollRestore: (tabId, scrollX, scrollY) => {
    pendingScrollRestore.set(tabId, { scrollX, scrollY });
  },
};

// Pending scroll restores — queued when a tab is re-opened, consumed when its content script reports ready
const pendingScrollRestore = new Map<number, { scrollX: number; scrollY: number }>();

// -- Tab Manager Actions --

async function tabManagerAdd(
  tab: Tabs.Tab,
): Promise<{ ok: boolean; reason?: string; slot?: number }> {
  await reconcileTabManager();
  if (tabManagerList.length >= MAX_TAB_MANAGER_SLOTS) {
    try {
      await browser.tabs.sendMessage(tab.id!, {
        type: "TAB_MANAGER_FULL_FEEDBACK",
        max: MAX_TAB_MANAGER_SLOTS,
      });
    } catch (_) {
      // Silent — toast is non-critical
    }
    return { ok: false, reason: `Tab Manager list is full (max ${MAX_TAB_MANAGER_SLOTS}).` };
  }
  // Check by tabId first, then by URL (catches closed entries for same page)
  const existing = tabManagerList.find(
    (e) => e.tabId === tab.id || e.url === tab.url,
  );
  if (existing) {
    // If it was a closed entry for the same URL, revive it with current tab
    if (existing.closed && existing.url === tab.url) {
      existing.tabId = tab.id!;
      existing.closed = false;
      existing.title = tab.title || existing.title;
      await saveTabManager();
    }
    try {
      await browser.tabs.sendMessage(tab.id!, {
        type: "TAB_MANAGER_ADDED_FEEDBACK",
        slot: existing.slot,
        title: tab.title,
        alreadyAdded: true,
      });
    } catch (_) {
      // Silent — toast is non-critical
    }
    return { ok: false, reason: "Tab already in Tab Manager list." };
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

  const slot = tabManagerList.length + 1;
  tabManagerList.push({
    tabId: tab.id!,
    url: tab.url || "",
    title: tab.title || "",
    scrollX,
    scrollY,
    slot,
  });
  await saveTabManager();

  // Show "Added" toast via content script
  try {
    await browser.tabs.sendMessage(tab.id!, {
      type: "TAB_MANAGER_ADDED_FEEDBACK",
      slot,
      title: tab.title,
    });
  } catch (_) {
    // Silent — toast is non-critical
  }
  return { ok: true, slot };
}

async function tabManagerRemove(tabId: number): Promise<void> {
  await ensureTabManagerLoaded();
  tabManagerList = tabManagerList.filter((e) => e.tabId !== tabId);
  recompactSlots();
  await saveTabManager();
}

/** Save current scroll, activate target tab, and restore its scroll position.
 *  If the tab was closed, re-open it from the stored URL. */
async function tabManagerJump(slot: number): Promise<void> {
  await ensureTabManagerLoaded();
  const entry = tabManagerList.find((e) => e.slot === slot);
  if (!entry) return;

  // Tab was previously closed — re-open it
  if (entry.closed) {
    await saveCurrentTabScroll();
    try {
      const newTab = await browser.tabs.create({ url: entry.url, active: true });
      entry.tabId = newTab.id!;
      entry.closed = false;
      await saveTabManager();
      // Queue scroll restore — content script will pick it up when ready
      if (entry.scrollX || entry.scrollY) {
        pendingScrollRestore.set(newTab.id!, { scrollX: entry.scrollX, scrollY: entry.scrollY });
      }
    } catch (_) {
      // URL may be restricted — remove the entry
      tabManagerList = tabManagerList.filter((e) => e.slot !== slot);
      recompactSlots();
      await saveTabManager();
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
    await saveTabManager();
    await tabManagerJump(slot);
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

/** Persist scroll position of the currently active tab manager tab */
async function saveCurrentTabScroll(): Promise<void> {
  await ensureTabManagerLoaded();
  const [activeTab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab) return;
  const entry = tabManagerList.find((e) => e.tabId === activeTab.id);
  if (!entry || entry.closed) return;
  try {
    const response = (await browser.tabs.sendMessage(activeTab.id!, {
      type: "GET_SCROLL",
    })) as ScrollData;
    entry.scrollX = response.scrollX || 0;
    entry.scrollY = response.scrollY || 0;
    await saveTabManager();
  } catch (_) {
    // Content script unavailable
  }
}

// Track the previously active tab so onActivated only saves scroll for it
let lastActiveTabId: number | null = null;

// -- Tab Lifecycle --

browser.tabs.onRemoved.addListener(async (tabId: number) => {
  await ensureTabManagerLoaded();
  const entry = tabManagerList.find((e) => e.tabId === tabId);
  if (entry) {
    entry.closed = true;
    await saveTabManager();
  }

  // Clean frecency data for closed tabs
  await removeFrecencyEntry(tabId);
});

// Debounced save for onUpdated — coalesces rapid title/URL changes (SPAs)
let onUpdatedSaveTimer: ReturnType<typeof setTimeout> | null = null;

browser.tabs.onUpdated.addListener(
  async (tabId: number, changeInfo: Tabs.OnUpdatedChangeInfoType) => {
    await ensureTabManagerLoaded();
    const entry = tabManagerList.find((e) => e.tabId === tabId);
    if (entry) {
      let changed = false;
      if (changeInfo.url) { entry.url = changeInfo.url; changed = true; }
      if (changeInfo.title) { entry.title = changeInfo.title; changed = true; }
      if (changed) {
        if (onUpdatedSaveTimer) clearTimeout(onUpdatedSaveTimer);
        onUpdatedSaveTimer = setTimeout(() => {
          onUpdatedSaveTimer = null;
          saveTabManager();
        }, 500);
      }
    }
  },
);

// Save scroll position for previously active tab manager tab + record frecency
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

    await ensureTabManagerLoaded();
    const entry = tabManagerList.find((e) => e.tabId === prevTabId);
    if (!entry || entry.closed) return;

    try {
      const response = (await browser.tabs.sendMessage(prevTabId, {
        type: "GET_SCROLL",
      })) as ScrollData;
      entry.scrollX = response.scrollX || 0;
      entry.scrollY = response.scrollY || 0;
      await saveTabManager();
    } catch (_) {
      // Tab may not have content script
    }
  },
);

// -- Search Current Page: Grep --

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
    case "open-search-current":
      try {
        await browser.tabs.sendMessage(activeTab.id!, {
          type: "OPEN_SEARCH_CURRENT_PAGE",
        });
      } catch (_) {}
      break;
    case "open-tab-manager":
      try {
        await browser.tabs.sendMessage(activeTab.id!, {
          type: "OPEN_TAB_MANAGER",
        });
      } catch (_) {}
      break;
    case "tab-manager-add":
      await tabManagerAdd(activeTab);
      break;
    case "tab-manager-tab-1":
      await tabManagerJump(1);
      break;
    case "tab-manager-tab-2":
      await tabManagerJump(2);
      break;
    case "tab-manager-tab-3":
      await tabManagerJump(3);
      break;
    case "tab-manager-tab-4":
      await tabManagerJump(4);
      break;
  }
});

// -- Message Router --

browser.runtime.onMessage.addListener(
  async (msg: unknown, sender: browser.Runtime.MessageSender): Promise<unknown> => {
    const m = msg as BackgroundRuntimeMessage;
    switch (m.type) {
      case "GREP_CURRENT":
        return await grepCurrentTab(m.query, m.filters || []);
      case "GET_PAGE_CONTENT":
        return await getPageContent(m.tabId);
      case "TAB_MANAGER_ADD": {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        return await tabManagerAdd(tab);
      }
      case "TAB_MANAGER_REMOVE":
        await tabManagerRemove(m.tabId);
        return { ok: true };
      case "TAB_MANAGER_LIST":
        await reconcileTabManager();
        return tabManagerList;
      case "TAB_MANAGER_JUMP":
        await tabManagerJump(m.slot);
        return { ok: true };
      case "TAB_MANAGER_CYCLE": {
        await ensureTabManagerLoaded();
        if (tabManagerList.length === 0) return { ok: false };
        const [curTab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        const curIdx = curTab
          ? tabManagerList.findIndex((e) => e.tabId === curTab.id)
          : -1;
        const dir = m.direction;
        let targetIdx: number;
        if (curIdx === -1) {
          // Current tab not in tab manager — jump to first or last
          targetIdx = dir === "next" ? 0 : tabManagerList.length - 1;
        } else {
          targetIdx =
            dir === "next"
              ? (curIdx + 1) % tabManagerList.length
              : (curIdx - 1 + tabManagerList.length) % tabManagerList.length;
        }
        await tabManagerJump(tabManagerList[targetIdx].slot);
        return { ok: true };
      }
      case "TAB_MANAGER_SAVE_SCROLL":
        await saveCurrentTabScroll();
        return { ok: true };
      case "TAB_MANAGER_REORDER":
        await ensureTabManagerLoaded();
        tabManagerList = m.list;
        recompactSlots();
        await saveTabManager();
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
        await saveKeybindings(m.config);
        return { ok: true };
      case "SWITCH_TO_TAB":
        try {
          await browser.tabs.update(m.tabId, { active: true });
        } catch (_) {}
        return { ok: true };
      case "FRECENCY_LIST":
        return await getFrecencyList();
      case "BOOKMARK_LIST":
        return await getBookmarkList();
      case "HISTORY_LIST": {
        const maxResults = m.maxResults || 500;
        const text = m.text || "";
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
        const url = m.url;
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
            opts.parentId = m.parentId;
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
            delete bookmarkUsageMap[m.url];
            await saveBookmarkUsage();
          }
          return { ok: true };
        } catch (_) {
          return { ok: false, reason: "Failed to remove bookmark" };
        }
      }
      case "BOOKMARK_REMOVE_TREE": {
        try {
          await browser.bookmarks.removeTree(m.id);
          return { ok: true };
        } catch (_) {
          return { ok: false, reason: "Failed to remove folder" };
        }
      }
      case "BOOKMARK_FOLDERS":
        return await getBookmarkFolders();
      case "BOOKMARK_CREATE_FOLDER": {
        try {
          const opts: browser.Bookmarks.CreateDetails = {
            title: m.title,
          };
          if (m.parentId) {
            opts.parentId = m.parentId;
          }
          const created = await browser.bookmarks.create(opts);
          return { ok: true, title: m.title, id: created.id };
        } catch (_) {
          return { ok: false, reason: "Failed to create folder" };
        }
      }
      case "BOOKMARK_MOVE": {
        try {
          const dest: { parentId?: string; index?: number } = {};
          if (m.parentId) dest.parentId = m.parentId;
          await browser.bookmarks.move(m.id, dest);
          return { ok: true };
        } catch (_) {
          return { ok: false, reason: "Failed to move bookmark" };
        }
      }
      case "CONTENT_SCRIPT_READY": {
        const tabId = sender.tab?.id;
        if (tabId == null) return { ok: true };
        const pending = pendingScrollRestore.get(tabId);
        if (pending) {
          pendingScrollRestore.delete(tabId);
          browser.tabs
            .sendMessage(tabId, { type: "SET_SCROLL", scrollX: pending.scrollX, scrollY: pending.scrollY })
            .catch(() => {});
        }
        return { ok: true };
      }
      case "SESSION_SAVE":
        return await sessionSave(tabManagerState, m.name);
      case "SESSION_LIST":
        return await sessionList();
      case "SESSION_LOAD":
        return await sessionLoad(tabManagerState, m.name);
      case "SESSION_DELETE":
        return await sessionDelete(m.name);
      case "SESSION_RENAME":
        return await sessionRename(m.oldName, m.newName);
      case "SESSION_UPDATE":
        return await sessionUpdate(tabManagerState, m.name);
      default:
        return null;
    }
  },
);

// -- Init --
// Eagerly load tab manager state and capture the initial active tab (non-blocking)
ensureTabManagerLoaded();
browser.tabs
  .query({ active: true, currentWindow: true })
  .then(([tab]) => {
    if (tab?.id) lastActiveTabId = tab.id;
  })
  .catch(() => {});

// -- Session restore prompt on browser startup --
browser.runtime.onStartup.addListener(async () => {
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  if (sessions.length === 0) return;

  // Clear stale tab manager state from previous browser session
  // (all tabs have new IDs after restart)
  await ensureTabManagerLoaded();
  tabManagerList = [];
  await saveTabManager();

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
