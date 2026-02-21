import browser, { Tabs } from "webextension-polyfill";
import { MAX_TAB_MANAGER_SLOTS } from "../shared/keybindings";
import { TabManagerState } from "../shared/sessions";
import { normalizeUrlForMatch } from "../shared/helpers";

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
  let scrollRestoreSeq = 0;

  // Pending scroll restores are consumed once a content script confirms readiness.
  const pendingScrollRestore = new Map<number, { scrollX: number; scrollY: number }>();
  const pendingScrollRestoreTokens = new Map<number, number>();

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

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    let changed = false;
    for (const entry of tabManagerList) {
      const shouldBeClosed = !tabIds.has(entry.tabId);
      if (entry.closed !== shouldBeClosed) {
        entry.closed = shouldBeClosed;
        changed = true;
      }
    }
    for (let i = 0; i < tabManagerList.length; i++) {
      const nextSlot = i + 1;
      if (tabManagerList[i].slot !== nextSlot) {
        tabManagerList[i].slot = nextSlot;
        changed = true;
      }
    }
    if (changed) await saveTabManager();
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

    const normalizedTabUrl = normalizeUrlForMatch(tab.url || "");
    const existing = tabManagerList.find((entry) =>
      entry.tabId === tab.id
      || (
        normalizedTabUrl.length > 0
        && normalizeUrlForMatch(entry.url) === normalizedTabUrl
      ));
    if (existing) {
      if (existing.closed && normalizedTabUrl.length > 0 && normalizeUrlForMatch(existing.url) === normalizedTabUrl) {
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
    pendingScrollRestore.delete(tabId);
    pendingScrollRestoreTokens.delete(tabId);
    recompactSlots();
    await saveTabManager();
  }

  async function captureManagedTabScroll(tabId: number): Promise<boolean> {
    const entry = tabManagerList.find((candidate) => candidate.tabId === tabId);
    if (!entry || entry.closed) return false;

    try {
      const response = (await browser.tabs.sendMessage(tabId, {
        type: "GET_SCROLL",
      })) as ScrollData;
      const nextX = response.scrollX || 0;
      const nextY = response.scrollY || 0;
      if (entry.scrollX === nextX && entry.scrollY === nextY) return false;
      entry.scrollX = nextX;
      entry.scrollY = nextY;
      return true;
    } catch (_) {
      // Content script may be unavailable on restricted pages.
      return false;
    }
  }

  async function saveCurrentTabScroll(): Promise<void> {
    await ensureTabManagerLoaded();
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || activeTab.id == null) return;
    if (await captureManagedTabScroll(activeTab.id)) await saveTabManager();
  }

  function scheduleScrollRestore(tabId: number, scrollX: number, scrollY: number): void {
    if (!scrollX && !scrollY) {
      pendingScrollRestore.delete(tabId);
      pendingScrollRestoreTokens.delete(tabId);
      return;
    }

    pendingScrollRestore.set(tabId, { scrollX, scrollY });
    const token = ++scrollRestoreSeq;
    pendingScrollRestoreTokens.set(tabId, token);
    const retryDelaysMs = [0, 80, 220, 420];

    void (async () => {
      for (const delay of retryDelaysMs) {
        if (pendingScrollRestoreTokens.get(tabId) !== token) return;
        if (delay > 0) await sleep(delay);

        try {
          await browser.tabs.sendMessage(tabId, {
            type: "SET_SCROLL",
            scrollX,
            scrollY,
          });
          if (pendingScrollRestoreTokens.get(tabId) !== token) return;
          pendingScrollRestore.delete(tabId);
          pendingScrollRestoreTokens.delete(tabId);
          return;
        } catch (_) {
          // Content script may not be ready yet; keep retrying.
        }
      }
    })();
  }

  async function tabManagerJump(slot: number): Promise<void> {
    await ensureTabManagerLoaded();
    const entry = tabManagerList.find((candidate) => candidate.slot === slot);
    if (!entry) return;

    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    const previousTabId = activeTab?.id;
    if (previousTabId != null && previousTabId !== entry.tabId) {
      if (await captureManagedTabScroll(previousTabId)) await saveTabManager();
    }

    if (entry.closed) {
      try {
        const newTab = await browser.tabs.create({ url: entry.url, active: true });
        if (newTab.id == null) return;
        entry.tabId = newTab.id;
        entry.closed = false;
        await saveTabManager();
        scheduleScrollRestore(newTab.id, entry.scrollX, entry.scrollY);
      } catch (_) {
        tabManagerList = tabManagerList.filter((candidate) => candidate.slot !== slot);
        recompactSlots();
        await saveTabManager();
      }
      return;
    }

    const switched = await browser.tabs.update(entry.tabId, { active: true }).catch(() => null);

    if (!switched) {
      entry.closed = true;
      await saveTabManager();
      await tabManagerJump(slot);
      return;
    }

    scheduleScrollRestore(entry.tabId, entry.scrollX, entry.scrollY);
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
    if (pending) {
      pendingScrollRestore.delete(tabId);
      pendingScrollRestoreTokens.delete(tabId);
    }
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
      pendingScrollRestore.delete(tabId);
      pendingScrollRestoreTokens.delete(tabId);
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
      if (await captureManagedTabScroll(previousTabId)) await saveTabManager();
    });
  }

  const state: TabManagerState = {
    getList: () => tabManagerList,
    setList: (list) => { tabManagerList = list; },
    recompactSlots,
    save: saveTabManager,
    ensureLoaded: ensureTabManagerLoaded,
    queueScrollRestore: (tabId, scrollX, scrollY) => {
      scheduleScrollRestore(tabId, scrollX, scrollY);
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
