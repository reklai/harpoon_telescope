// Session CRUD handlers — save, list, load, and delete tab manager sessions.
// Extracted from background.ts; requires access to tab manager state via TabManagerState interface.

import browser from "webextension-polyfill";
import type { Tabs } from "webextension-polyfill";
import { MAX_SESSIONS } from "./keybindings";
import { normalizeUrlForMatch } from "./helpers";

/** Interface for accessing tab manager state from the background script */
export interface TabManagerState {
  getList(): TabManagerEntry[];
  setList(list: TabManagerEntry[]): void;
  recompactSlots(): void;
  save(): Promise<void>;
  ensureLoaded(): Promise<void>;
  queueScrollRestore(tabId: number, scrollX: number, scrollY: number): void;
}

interface SessionLoadComputation {
  reuseTabIds: Array<number | null>;
  openCount: number;
  reuseCount: number;
}

function buildReusableTabPools(tabs: Tabs.Tab[]): Map<string, number[]> {
  const pools = new Map<string, number[]>();
  for (const tab of tabs) {
    if (tab.id == null) continue;
    const normalized = normalizeUrlForMatch(tab.url || "");
    if (!normalized) continue;
    const pool = pools.get(normalized);
    if (pool) {
      pool.push(tab.id);
    } else {
      pools.set(normalized, [tab.id]);
    }
  }
  return pools;
}

function computeSessionLoad(entries: TabManagerSessionEntry[], openTabs: Tabs.Tab[]): SessionLoadComputation {
  const pools = buildReusableTabPools(openTabs);
  const reuseTabIds: Array<number | null> = [];
  let reuseCount = 0;
  let openCount = 0;

  for (const entry of entries) {
    const normalized = normalizeUrlForMatch(entry.url);
    const pool = normalized ? pools.get(normalized) : undefined;
    if (pool && pool.length > 0) {
      reuseTabIds.push(pool.shift() ?? null);
      reuseCount++;
    } else {
      reuseTabIds.push(null);
      openCount++;
    }
  }

  return { reuseTabIds, reuseCount, openCount };
}

export async function sessionSave(
  state: TabManagerState,
  name: string,
): Promise<{ ok: boolean; reason?: string }> {
  await state.ensureLoaded();
  if (state.getList().length === 0) {
    return { ok: false, reason: "Cannot save empty tab manager list" };
  }
  const sessionEntries: TabManagerSessionEntry[] = state.getList().map((entry) => ({
    url: entry.url,
    title: entry.title,
    scrollX: entry.scrollX,
    scrollY: entry.scrollY,
  }));
  const session: TabManagerSession = {
    name,
    entries: sessionEntries,
    savedAt: Date.now(),
  };
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  // Reject duplicate names (case-insensitive)
  const nameTaken = sessions.some(
    (existingSession) => existingSession.name.toLowerCase() === name.toLowerCase(),
  );
  if (nameTaken) {
    return { ok: false, reason: `"${name}" already exists` };
  }
  if (sessions.length >= MAX_SESSIONS) {
    return { ok: false, reason: `Max ${MAX_SESSIONS} sessions — delete one first` };
  }
  sessions.push(session);
  await browser.storage.local.set({ tabManagerSessions: sessions });
  return { ok: true };
}

export async function sessionList(): Promise<TabManagerSession[]> {
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  return sessions
    .slice()
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function sessionLoadPlan(
  state: TabManagerState,
  name: string,
): Promise<{ ok: boolean; reason?: string; summary?: SessionLoadSummary }> {
  await state.ensureLoaded();
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  const session = sessions.find((savedSession) => savedSession.name === name);
  if (!session) return { ok: false, reason: "Session not found" };

  const openTabs = await browser.tabs.query({});
  const computation = computeSessionLoad(session.entries, openTabs);
  return {
    ok: true,
    summary: {
      sessionName: session.name,
      totalCount: session.entries.length,
      replaceCount: state.getList().length,
      openCount: computation.openCount,
      reuseCount: computation.reuseCount,
    },
  };
}

export async function sessionLoad(
  state: TabManagerState,
  name: string,
): Promise<{
  ok: boolean;
  reason?: string;
  count?: number;
  replaceCount?: number;
  openCount?: number;
  reuseCount?: number;
}> {
  await state.ensureLoaded();
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  const session = sessions.find((savedSession) => savedSession.name === name);
  if (!session) return { ok: false, reason: "Session not found" };

  const replaceCount = state.getList().length;
  const openTabs = await browser.tabs.query({});
  const loadPlan = computeSessionLoad(session.entries, openTabs);

  const newList: TabManagerEntry[] = [];
  let openedCount = 0;
  let reusedCount = 0;

  for (let i = 0; i < session.entries.length; i++) {
    const entry = session.entries[i];
    const reusableTabId = loadPlan.reuseTabIds[i];
    if (reusableTabId != null) {
      try {
        const reusedTab = await browser.tabs.get(reusableTabId);
        if (reusedTab.id == null) throw new Error("Reusable tab missing id");
        newList.push({
          tabId: reusedTab.id,
          url: reusedTab.url || entry.url,
          title: reusedTab.title || entry.title,
          scrollX: entry.scrollX,
          scrollY: entry.scrollY,
          slot: newList.length + 1,
        });
        if (entry.scrollX || entry.scrollY) {
          state.queueScrollRestore(reusedTab.id, entry.scrollX, entry.scrollY);
        }
        reusedCount++;
        continue;
      } catch (_) {
        // Reused candidate tab may have closed; fall back to opening.
      }
    }

    try {
      const tab = await browser.tabs.create({ url: entry.url, active: false });
      newList.push({
        tabId: tab.id!,
        url: entry.url,
        title: entry.title,
        scrollX: entry.scrollX,
        scrollY: entry.scrollY,
        slot: newList.length + 1,
      });
      openedCount++;

      if (entry.scrollX || entry.scrollY) {
        state.queueScrollRestore(tab.id!, entry.scrollX, entry.scrollY);
      }
    } catch (_) {
      // Skip entries that fail to open
    }
  }

  state.setList(newList);
  state.recompactSlots();
  await state.save();

  // Activate the first tab if any were created
  if (newList.length > 0) {
    await browser.tabs.update(newList[0].tabId, { active: true });
  }
  return {
    ok: true,
    count: newList.length,
    replaceCount,
    openCount: openedCount,
    reuseCount: reusedCount,
  };
}

export async function sessionRename(
  oldName: string,
  newName: string,
): Promise<{ ok: boolean; reason?: string }> {
  const trimmed = newName.trim();
  if (!trimmed) return { ok: false, reason: "Name cannot be empty" };
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  const session = sessions.find((savedSession) => savedSession.name === oldName);
  if (!session) return { ok: false, reason: "Session not found" };
  // Reject duplicate names (case-insensitive), excluding the session being renamed
  const nameTaken = sessions.some(
    (savedSession) =>
      savedSession.name !== oldName
      && savedSession.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (nameTaken) return { ok: false, reason: `"${trimmed}" already exists` };
  session.name = trimmed;
  await browser.storage.local.set({ tabManagerSessions: sessions });
  return { ok: true };
}

export async function sessionUpdate(
  state: TabManagerState,
  name: string,
): Promise<{ ok: boolean; reason?: string }> {
  await state.ensureLoaded();
  if (state.getList().length === 0) {
    return { ok: false, reason: "Cannot update — tab manager list is empty" };
  }
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  const session = sessions.find((savedSession) => savedSession.name === name);
  if (!session) return { ok: false, reason: "Session not found" };
  session.entries = state.getList().map((entry) => ({
    url: entry.url,
    title: entry.title,
    scrollX: entry.scrollX,
    scrollY: entry.scrollY,
  }));
  session.savedAt = Date.now();
  await browser.storage.local.set({ tabManagerSessions: sessions });
  return { ok: true };
}

export async function sessionReplace(
  state: TabManagerState,
  oldName: string,
  newName: string,
): Promise<{ ok: boolean; reason?: string }> {
  await state.ensureLoaded();
  if (state.getList().length === 0) {
    return { ok: false, reason: "Cannot replace — tab manager list is empty" };
  }

  const trimmed = newName.trim();
  if (!trimmed) return { ok: false, reason: "Name cannot be empty" };

  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  const targetIndex = sessions.findIndex((savedSession) => savedSession.name === oldName);
  if (targetIndex === -1) return { ok: false, reason: "Session not found" };

  const nameTaken = sessions.some(
    (savedSession, index) =>
      index !== targetIndex
      && savedSession.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (nameTaken) return { ok: false, reason: `"${trimmed}" already exists` };

  sessions[targetIndex] = {
    name: trimmed,
    entries: state.getList().map((entry) => ({
      url: entry.url,
      title: entry.title,
      scrollX: entry.scrollX,
      scrollY: entry.scrollY,
    })),
    savedAt: Date.now(),
  };

  await browser.storage.local.set({ tabManagerSessions: sessions });
  return { ok: true };
}

export async function sessionDelete(name: string): Promise<{ ok: boolean }> {
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  const filtered = sessions.filter((savedSession) => savedSession.name !== name);
  await browser.storage.local.set({ tabManagerSessions: filtered });
  return { ok: true };
}
