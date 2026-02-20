import browser, { Tabs } from "webextension-polyfill";
import { MAX_TAB_MANAGER_SLOTS } from "../shared/keybindings";
import { TabManagerState } from "../shared/sessions";

export interface TabManagerDomainHooks {
  onTabClosed(tabId: number): Promise<void>;
  onTabActivated(tabId: number): Promise<void>;
}

export interface TabManagerDomain {
  state: TabManagerState;
  list(): TabManagerEntry[];
  ensureLoaded(): Promise<void>;
  reconcile(): Promise<void>;
  add(tab: Tabs.Tab): Promise<{ ok: boolean; reason?: string; slot?: number }>;
  remove(tabId: number): Promise<void>;
  jump(slot: number): Promise<void>;
  cycle(direction: "prev" | "next"): Promise<{ ok: boolean }>;
  saveCurrentTabScroll(): Promise<void>;
  reorder(list: TabManagerEntry[]): Promise<void>;
  consumePendingScrollRestore(tabId: number): { scrollX: number; scrollY: number } | null;
  clearAll(): Promise<void>;
  captureInitialActiveTab(): Promise<void>;
  registerLifecycleListeners(hooks: TabManagerDomainHooks): void;
}

export function createTabManagerDomain(): TabManagerDomain {
  let tabManagerList: TabManagerEntry[] = [];
  let tabManagerLoaded = false;
  let lastActiveTabId: number | null = null;
  let onUpdatedSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending scroll restores are consumed once a content script confirms readiness.
  const pendingScrollRestore = new Map<number, { scrollX: number; scrollY: number }>();

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

  function recompactSlots(): void {
    tabManagerList.forEach((entry, index) => {
      entry.slot = index + 1;
    });
  }

  async function reconcileTabManager(): Promise<void> {
    await ensureTabManagerLoaded();
    const tabs = await browser.tabs.query({});
    const tabIds = new Set(tabs.map((tab) => tab.id));
    for (const entry of tabManagerList) {
      entry.closed = !tabIds.has(entry.tabId);
    }
    recompactSlots();
    await saveTabManager();
  }

  async function tabManagerAdd(
    tab: Tabs.Tab,
  ): Promise<{ ok: boolean; reason?: string; slot?: number }> {
    if (tab.id == null) {
      return { ok: false, reason: "Active tab unavailable." };
    }

    await reconcileTabManager();
    if (tabManagerList.length >= MAX_TAB_MANAGER_SLOTS) {
      try {
        await browser.tabs.sendMessage(tab.id, {
          type: "TAB_MANAGER_FULL_FEEDBACK",
          max: MAX_TAB_MANAGER_SLOTS,
        });
      } catch (_) {
        // Toast delivery is best-effort.
      }
      return { ok: false, reason: `Tab Manager list is full (max ${MAX_TAB_MANAGER_SLOTS}).` };
    }

    const existing = tabManagerList.find((entry) => entry.tabId === tab.id || entry.url === tab.url);
    if (existing) {
      if (existing.closed && existing.url === tab.url) {
        existing.tabId = tab.id;
        existing.closed = false;
        existing.title = tab.title || existing.title;
        await saveTabManager();
      }
      try {
        await browser.tabs.sendMessage(tab.id, {
          type: "TAB_MANAGER_ADDED_FEEDBACK",
          slot: existing.slot,
          title: tab.title,
          alreadyAdded: true,
        });
      } catch (_) {
        // Toast delivery is best-effort.
      }
      return { ok: false, reason: "Tab already in Tab Manager list." };
    }

    let scrollX = 0;
    let scrollY = 0;
    try {
      const response = (await browser.tabs.sendMessage(tab.id, {
        type: "GET_SCROLL",
      })) as ScrollData;
      scrollX = response.scrollX || 0;
      scrollY = response.scrollY || 0;
    } catch (_) {
      // Content script may be unavailable on restricted pages.
    }

    const slot = tabManagerList.length + 1;
    tabManagerList.push({
      tabId: tab.id,
      url: tab.url || "",
      title: tab.title || "",
      scrollX,
      scrollY,
      slot,
    });
    await saveTabManager();

    try {
      await browser.tabs.sendMessage(tab.id, {
        type: "TAB_MANAGER_ADDED_FEEDBACK",
        slot,
        title: tab.title,
      });
    } catch (_) {
      // Toast delivery is best-effort.
    }

    return { ok: true, slot };
  }

  async function tabManagerRemove(tabId: number): Promise<void> {
    await ensureTabManagerLoaded();
    tabManagerList = tabManagerList.filter((entry) => entry.tabId !== tabId);
    recompactSlots();
    await saveTabManager();
  }

  async function saveCurrentTabScroll(): Promise<void> {
    await ensureTabManagerLoaded();
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || activeTab.id == null) return;

    const entry = tabManagerList.find((candidate) => candidate.tabId === activeTab.id);
    if (!entry || entry.closed) return;

    try {
      const response = (await browser.tabs.sendMessage(activeTab.id, {
        type: "GET_SCROLL",
      })) as ScrollData;
      entry.scrollX = response.scrollX || 0;
      entry.scrollY = response.scrollY || 0;
      await saveTabManager();
    } catch (_) {
      // Content script may be unavailable on restricted pages.
    }
  }

  async function tabManagerJump(slot: number): Promise<void> {
    await ensureTabManagerLoaded();
    const entry = tabManagerList.find((candidate) => candidate.slot === slot);
    if (!entry) return;

    if (entry.closed) {
      await saveCurrentTabScroll();
      try {
        const newTab = await browser.tabs.create({ url: entry.url, active: true });
        if (newTab.id == null) return;
        entry.tabId = newTab.id;
        entry.closed = false;
        await saveTabManager();

        if (entry.scrollX || entry.scrollY) {
          pendingScrollRestore.set(newTab.id, {
            scrollX: entry.scrollX,
            scrollY: entry.scrollY,
          });
        }
      } catch (_) {
        tabManagerList = tabManagerList.filter((candidate) => candidate.slot !== slot);
        recompactSlots();
        await saveTabManager();
      }
      return;
    }

    const [, switched] = await Promise.all([
      saveCurrentTabScroll(),
      browser.tabs.update(entry.tabId, { active: true }).catch(() => null),
    ]);

    if (!switched) {
      entry.closed = true;
      await saveTabManager();
      await tabManagerJump(slot);
      return;
    }

    browser.tabs.sendMessage(entry.tabId, {
      type: "SET_SCROLL",
      scrollX: entry.scrollX,
      scrollY: entry.scrollY,
    }).catch(() => {});
  }

  async function tabManagerCycle(direction: "prev" | "next"): Promise<{ ok: boolean }> {
    await ensureTabManagerLoaded();
    if (tabManagerList.length === 0) return { ok: false };

    const [currentTab] = await browser.tabs.query({ active: true, currentWindow: true });
    const currentIdx = currentTab
      ? tabManagerList.findIndex((entry) => entry.tabId === currentTab.id)
      : -1;

    let targetIdx: number;
    if (currentIdx === -1) {
      targetIdx = direction === "next" ? 0 : tabManagerList.length - 1;
    } else {
      targetIdx =
        direction === "next"
          ? (currentIdx + 1) % tabManagerList.length
          : (currentIdx - 1 + tabManagerList.length) % tabManagerList.length;
    }

    await tabManagerJump(tabManagerList[targetIdx].slot);
    return { ok: true };
  }

  async function reorder(list: TabManagerEntry[]): Promise<void> {
    await ensureTabManagerLoaded();
    tabManagerList = list;
    recompactSlots();
    await saveTabManager();
  }

  function consumePendingScrollRestore(tabId: number): { scrollX: number; scrollY: number } | null {
    const pending = pendingScrollRestore.get(tabId) || null;
    if (pending) pendingScrollRestore.delete(tabId);
    return pending;
  }

  async function clearAll(): Promise<void> {
    await ensureTabManagerLoaded();
    tabManagerList = [];
    await saveTabManager();
  }

  async function captureInitialActiveTab(): Promise<void> {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id != null) lastActiveTabId = tab.id;
    } catch (_) {
      // Best effort only.
    }
  }

  function registerLifecycleListeners(hooks: TabManagerDomainHooks): void {
    browser.tabs.onRemoved.addListener(async (tabId: number) => {
      await ensureTabManagerLoaded();
      const entry = tabManagerList.find((candidate) => candidate.tabId === tabId);
      if (entry) {
        entry.closed = true;
        await saveTabManager();
      }
      await hooks.onTabClosed(tabId);
    });

    browser.tabs.onUpdated.addListener(async (tabId: number, changeInfo: Tabs.OnUpdatedChangeInfoType) => {
      await ensureTabManagerLoaded();
      const entry = tabManagerList.find((candidate) => candidate.tabId === tabId);
      if (!entry) return;

      let changed = false;
      if (changeInfo.url) {
        entry.url = changeInfo.url;
        changed = true;
      }
      if (changeInfo.title) {
        entry.title = changeInfo.title;
        changed = true;
      }

      if (!changed) return;
      if (onUpdatedSaveTimer) clearTimeout(onUpdatedSaveTimer);
      onUpdatedSaveTimer = setTimeout(() => {
        onUpdatedSaveTimer = null;
        saveTabManager();
      }, 500);
    });

    browser.tabs.onActivated.addListener(async (activeInfo: Tabs.OnActivatedActiveInfoType) => {
      const previousTabId = lastActiveTabId;
      lastActiveTabId = activeInfo.tabId;

      await hooks.onTabActivated(activeInfo.tabId);

      if (previousTabId == null) return;
      await ensureTabManagerLoaded();

      const entry = tabManagerList.find((candidate) => candidate.tabId === previousTabId);
      if (!entry || entry.closed) return;

      try {
        const response = (await browser.tabs.sendMessage(previousTabId, {
          type: "GET_SCROLL",
        })) as ScrollData;
        entry.scrollX = response.scrollX || 0;
        entry.scrollY = response.scrollY || 0;
        await saveTabManager();
      } catch (_) {
        // Content script may be unavailable.
      }
    });
  }

  const state: TabManagerState = {
    getList: () => tabManagerList,
    setList: (list) => { tabManagerList = list; },
    recompactSlots,
    save: saveTabManager,
    ensureLoaded: ensureTabManagerLoaded,
    queueScrollRestore: (tabId, scrollX, scrollY) => {
      pendingScrollRestore.set(tabId, { scrollX, scrollY });
    },
  };

  return {
    state,
    list: () => tabManagerList,
    ensureLoaded: ensureTabManagerLoaded,
    reconcile: reconcileTabManager,
    add: tabManagerAdd,
    remove: tabManagerRemove,
    jump: tabManagerJump,
    cycle: tabManagerCycle,
    saveCurrentTabScroll,
    reorder,
    consumePendingScrollRestore,
    clearAll,
    captureInitialActiveTab,
    registerLifecycleListeners,
  };
}
