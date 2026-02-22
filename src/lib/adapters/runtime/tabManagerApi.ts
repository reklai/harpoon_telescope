import { sendRuntimeMessage, sendRuntimeMessageWithRetry, RuntimeRetryPolicy } from "./runtimeClient";

export interface TabManagerMutationResult {
  ok: boolean;
  reason?: string;
  slot?: number;
}

export function listTabManagerEntries(): Promise<TabManagerEntry[]> {
  return sendRuntimeMessage<TabManagerEntry[]>({ type: "TAB_MANAGER_LIST" });
}

export function listTabManagerEntriesWithRetry(
  policy: RuntimeRetryPolicy = { retryDelaysMs: [0, 90, 240, 450] },
): Promise<TabManagerEntry[]> {
  return sendRuntimeMessageWithRetry<TabManagerEntry[]>(
    { type: "TAB_MANAGER_LIST" },
    policy,
  );
}

export function addCurrentTabToTabManager(): Promise<TabManagerMutationResult> {
  return sendRuntimeMessage<TabManagerMutationResult>({ type: "TAB_MANAGER_ADD" });
}

export function removeTabManagerEntry(tabId: number): Promise<TabManagerMutationResult> {
  return sendRuntimeMessage<TabManagerMutationResult>({ type: "TAB_MANAGER_REMOVE", tabId });
}

export function jumpToTabManagerSlot(slot: number): Promise<void> {
  return sendRuntimeMessage<void>({ type: "TAB_MANAGER_JUMP", slot });
}

export function cycleTabManagerSlot(direction: "prev" | "next"): Promise<void> {
  return sendRuntimeMessage<void>({ type: "TAB_MANAGER_CYCLE", direction });
}

export function reorderTabManagerEntries(list: TabManagerEntry[]): Promise<{ ok: boolean; reason?: string }> {
  return sendRuntimeMessage<{ ok: boolean; reason?: string }>({ type: "TAB_MANAGER_REORDER", list });
}
