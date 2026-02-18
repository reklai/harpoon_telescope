// Session CRUD handlers — save, list, load, and delete harpoon sessions.
// Extracted from background.ts; requires access to harpoon state via HarpoonState interface.

import browser from "webextension-polyfill";

/** Interface for accessing harpoon state from the background script */
export interface HarpoonState {
  getList(): HarpoonEntry[];
  setList(list: HarpoonEntry[]): void;
  recompactSlots(): void;
  save(): Promise<void>;
  ensureLoaded(): Promise<void>;
}

export async function sessionSave(
  state: HarpoonState,
  name: string,
): Promise<{ ok: boolean; reason?: string }> {
  await state.ensureLoaded();
  if (state.getList().length === 0) {
    return { ok: false, reason: "Cannot save empty harpoon list" };
  }
  const sessionEntries: HarpoonSessionEntry[] = state.getList().map((e) => ({
    url: e.url,
    title: e.title,
    scrollX: e.scrollX,
    scrollY: e.scrollY,
  }));
  const session: HarpoonSession = {
    name,
    entries: sessionEntries,
    savedAt: Date.now(),
  };
  const stored = await browser.storage.local.get("harpoonSessions");
  const sessions = (stored.harpoonSessions as HarpoonSession[]) || [];
  // Reject duplicate names (case-insensitive)
  const nameTaken = sessions.some((s) => s.name.toLowerCase() === name.toLowerCase());
  if (nameTaken) {
    return { ok: false, reason: `"${name}" already exists` };
  }
  if (sessions.length >= 3) {
    return { ok: false, reason: "Max 3 sessions — delete one first" };
  }
  sessions.push(session);
  await browser.storage.local.set({ harpoonSessions: sessions });
  return { ok: true };
}

export async function sessionList(): Promise<HarpoonSession[]> {
  const stored = await browser.storage.local.get("harpoonSessions");
  return (stored.harpoonSessions as HarpoonSession[]) || [];
}

export async function sessionLoad(
  state: HarpoonState,
  name: string,
): Promise<{ ok: boolean; reason?: string; count?: number }> {
  const stored = await browser.storage.local.get("harpoonSessions");
  const sessions = (stored.harpoonSessions as HarpoonSession[]) || [];
  const session = sessions.find((s) => s.name === name);
  if (!session) return { ok: false, reason: "Session not found" };

  // Clear current harpoon list
  const newList: HarpoonEntry[] = [];

  // Open tabs for each session entry and build new harpoon list
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

export async function sessionDelete(name: string): Promise<{ ok: boolean }> {
  const stored = await browser.storage.local.get("harpoonSessions");
  const sessions = (stored.harpoonSessions as HarpoonSession[]) || [];
  const filtered = sessions.filter((s) => s.name !== name);
  await browser.storage.local.set({ harpoonSessions: filtered });
  return { ok: true };
}
