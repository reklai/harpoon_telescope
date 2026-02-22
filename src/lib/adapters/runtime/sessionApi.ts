import { sendRuntimeMessage, sendRuntimeMessageWithRetry, RuntimeRetryPolicy } from "./runtimeClient";

export interface SessionMutationResult {
  ok: boolean;
  reason?: string;
}

export interface SessionLoadResult {
  ok: boolean;
  reason?: string;
  count?: number;
  openCount?: number;
  reuseCount?: number;
  replaceCount?: number;
}

export interface SessionLoadPlanResult {
  ok: boolean;
  reason?: string;
  summary?: SessionLoadSummary;
}

export function listSessions(): Promise<TabManagerSession[]> {
  return sendRuntimeMessage<TabManagerSession[]>({ type: "SESSION_LIST" });
}

export function listSessionsWithRetry(
  policy: RuntimeRetryPolicy = { retryDelaysMs: [0, 90, 240, 450] },
): Promise<TabManagerSession[]> {
  return sendRuntimeMessageWithRetry<TabManagerSession[]>(
    { type: "SESSION_LIST" },
    policy,
  );
}

export function saveSessionByName(name: string): Promise<SessionMutationResult> {
  return sendRuntimeMessage<SessionMutationResult>({ type: "SESSION_SAVE", name });
}

export function loadSessionByName(name: string): Promise<SessionLoadResult> {
  return sendRuntimeMessage<SessionLoadResult>({ type: "SESSION_LOAD", name });
}

export function loadSessionPlanByName(name: string): Promise<SessionLoadPlanResult> {
  return sendRuntimeMessage<SessionLoadPlanResult>({ type: "SESSION_LOAD_PLAN", name });
}

export function deleteSessionByName(name: string): Promise<{ ok: boolean }> {
  return sendRuntimeMessage<{ ok: boolean }>({ type: "SESSION_DELETE", name });
}

export function renameSession(oldName: string, newName: string): Promise<SessionMutationResult> {
  return sendRuntimeMessage<SessionMutationResult>({ type: "SESSION_RENAME", oldName, newName });
}

export function updateSession(name: string): Promise<SessionMutationResult> {
  return sendRuntimeMessage<SessionMutationResult>({ type: "SESSION_UPDATE", name });
}

export function replaceSession(
  oldName: string,
  newName: string,
): Promise<SessionMutationResult> {
  return sendRuntimeMessage<SessionMutationResult>({
    type: "SESSION_REPLACE",
    oldName,
    newName,
  });
}
