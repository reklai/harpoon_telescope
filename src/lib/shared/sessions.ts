// Session CRUD handlers — save, list, load, and delete tab manager sessions.
// Extracted from background.ts; requires access to tab manager state via TabManagerState interface.

import browser from "webextension-polyfill";
import { MAX_SESSIONS } from "./keybindings";

/** Interface for accessing tab manager state from the background script */
export interface TabManagerState {
  getList(): TabManagerEntry[];
  setList(list: TabManagerEntry[]): void;
  recompactSlots(): void;
  save(): Promise<void>;
  ensureLoaded(): Promise<void>;
  queueScrollRestore(tabId: number, scrollX: number, scrollY: number): void;
}

export async function sessionSave(
  state: TabManagerState,
  name: string,
): Promise<{ ok: boolean; reason?: string }> {
  await state.ensureLoaded();
  if (state.getList().length === 0) {
    return { ok: false, reason: "Cannot save empty tab manager list" };
  }
  const sessionEntries: TabManagerSessionEntry[] = state.getList().map((e) => ({
    url: e.url,
    title: e.title,
    scrollX: e.scrollX,
    scrollY: e.scrollY,
  }));
  const session: TabManagerSession = {
    name,
    entries: sessionEntries,
    savedAt: Date.now(),
  };
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  // Reject duplicate names (case-insensitive)
  const nameTaken = sessions.some((s) => s.name.toLowerCase() === name.toLowerCase());
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
  return (stored.tabManagerSessions as TabManagerSession[]) || [];
}

export async function sessionLoad(
  state: TabManagerState,
  name: string,
): Promise<{ ok: boolean; reason?: string; count?: number }> {
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  const session = sessions.find((s) => s.name === name);
  if (!session) return { ok: false, reason: "Session not found" };

  // Clear current tab manager list
  const newList: TabManagerEntry[] = [];

  // Open tabs for each session entry and build new tab manager list
  for (const entry of session.entries) {
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

      // Queue scroll restore — content script will pick it up when ready
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
  return { ok: true, count: newList.length };
}

export async function sessionRename(
  oldName: string,
  newName: string,
): Promise<{ ok: boolean; reason?: string }> {
  const trimmed = newName.trim();
  if (!trimmed) return { ok: false, reason: "Name cannot be empty" };
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  const session = sessions.find((s) => s.name === oldName);
  if (!session) return { ok: false, reason: "Session not found" };
  // Reject duplicate names (case-insensitive), excluding the session being renamed
  const nameTaken = sessions.some(
    (s) => s.name !== oldName && s.name.toLowerCase() === trimmed.toLowerCase(),
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
  const session = sessions.find((s) => s.name === name);
  if (!session) return { ok: false, reason: "Session not found" };
  session.entries = state.getList().map((e) => ({
    url: e.url,
    title: e.title,
    scrollX: e.scrollX,
    scrollY: e.scrollY,
  }));
  session.savedAt = Date.now();
  await browser.storage.local.set({ tabManagerSessions: sessions });
  return { ok: true };
}

export async function sessionDelete(name: string): Promise<{ ok: boolean }> {
  const stored = await browser.storage.local.get("tabManagerSessions");
  const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
  const filtered = sessions.filter((s) => s.name !== name);
  await browser.storage.local.set({ tabManagerSessions: filtered });
  return { ok: true };
}
