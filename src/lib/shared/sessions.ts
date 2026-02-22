// Session CRUD handlers — save, list, load, and delete tab manager sessions.
// Extracted from background.ts; requires access to tab manager state via TabManagerState interface.

import browser from "webextension-polyfill";
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

function resolveDisplayTitle(title: string | undefined, url: string | undefined): string {
  const trimmedTitle = (title || "").trim();
  if (trimmedTitle) return trimmedTitle;
  const trimmedUrl = (url || "").trim();
  if (trimmedUrl) return trimmedUrl;
  return "Untitled";
}

function buildSessionSlotDiffs(
  currentList: TabManagerEntry[],
  incomingEntries: TabManagerSessionEntry[],
): SessionLoadSlotDiff[] {
  const diffRows: SessionLoadSlotDiff[] = [];
  const maxLen = Math.max(currentList.length, incomingEntries.length);

  for (let i = 0; i < maxLen; i++) {
    const current = currentList[i];
    const incoming = incomingEntries[i];
    const slot = i + 1;

    if (current && incoming) {
      diffRows.push({
        slot,
        change: "replace",
        currentTitle: resolveDisplayTitle(current.title, current.url),
        currentUrl: current.url,
        incomingTitle: resolveDisplayTitle(incoming.title, incoming.url),
        incomingUrl: incoming.url,
      });
      continue;
    }

    if (current) {
      diffRows.push({
        slot,
        change: "remove",
        currentTitle: resolveDisplayTitle(current.title, current.url),
        currentUrl: current.url,
      });
      continue;
    }

    if (incoming) {
      diffRows.push({
        slot,
        change: "add",
        incomingTitle: resolveDisplayTitle(incoming.title, incoming.url),
        incomingUrl: incoming.url,
      });
    }
  }

  return diffRows;
}

function buildSessionReuseMatches(
  entries: TabManagerSessionEntry[],
  reuseTabIds: Array<number | null>,
  currentList: TabManagerEntry[],
): SessionLoadReuseMatch[] {
  const matches: SessionLoadReuseMatch[] = [];
  for (let i = 0; i < entries.length; i++) {
    const reusedTabId = reuseTabIds[i];
    if (reusedTabId == null) continue;
    const current = currentList[i];
    if (!current || current.tabId !== reusedTabId) continue;
    const entry = entries[i];
    matches.push({
      slot: i + 1,
      sessionTitle: resolveDisplayTitle(entry.title, entry.url),
      sessionUrl: entry.url,
      openTabTitle: resolveDisplayTitle(current.title, current.url),
      openTabUrl: current.url || entry.url,
    });
  }

  return matches;
}

function computeSessionLoad(
  entries: TabManagerSessionEntry[],
  currentList: TabManagerEntry[],
): SessionLoadComputation {
  const reuseTabIds: Array<number | null> = [];
  let reuseCount = 0;
  let openCount = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const current = currentList[i];
    const incomingUrl = normalizeUrlForMatch(entry.url);
    const currentUrl = normalizeUrlForMatch(current?.url || "");
    const isUnchangedSlot = !!(
      current
      && !current.closed
      && incomingUrl
      && currentUrl
      && incomingUrl === currentUrl
    );

    if (isUnchangedSlot) {
      reuseTabIds.push(current.tabId);
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
  const currentList = state.getList();
  if (currentList.length === 0) {
    return { ok: false, reason: "Cannot save empty tab manager list" };
  }
  const sessionEntries: TabManagerSessionEntry[] = currentList.map((entry) => ({
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
  const currentUrls = currentList.map((entry) => normalizeUrlForMatch(entry.url)).join("\n");
  const identicalSession = sessions.find((existingSession) => {
    const sessionUrls = existingSession.entries
      .map((entry) => normalizeUrlForMatch(entry.url))
      .join("\n");
    return sessionUrls === currentUrls;
  });
  if (identicalSession) {
    return { ok: false, reason: `Identical to "${identicalSession.name}"` };
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

  const currentList = state.getList();
  const computation = computeSessionLoad(session.entries, currentList);
  const slotDiffs = buildSessionSlotDiffs(currentList, session.entries);
  const reuseMatches = buildSessionReuseMatches(session.entries, computation.reuseTabIds, currentList);

  return {
    ok: true,
    summary: {
      sessionName: session.name,
      totalCount: session.entries.length,
      replaceCount: currentList.length,
      openCount: computation.openCount,
      reuseCount: computation.reuseCount,
      slotDiffs,
      reuseMatches,
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

  const currentList = state.getList();
  const replaceCount = currentList.length;
  const loadPlan = computeSessionLoad(session.entries, currentList);

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
