import { sendRuntimeMessage, sendRuntimeMessageWithRetry, RuntimeRetryPolicy } from "./runtimeClient";

export function listFrecencyEntriesWithRetry(
  policy: RuntimeRetryPolicy = { retryDelaysMs: [0, 80, 220, 420] },
): Promise<FrecencyEntry[]> {
  return sendRuntimeMessageWithRetry<FrecencyEntry[]>(
    { type: "FRECENCY_LIST" },
    policy,
  );
}

export function switchToTabById(tabId: number): Promise<{ ok?: boolean }> {
  return sendRuntimeMessage<{ ok?: boolean }>({ type: "SWITCH_TO_TAB", tabId });
}
