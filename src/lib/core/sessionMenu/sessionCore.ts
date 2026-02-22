// Pure session-menu state machine helpers.
// DOM-free transitions + derived view-model selectors for save/load session flows.

export type SessionListFocusTarget = "filter" | "list";

export interface SessionTransientState {
  isRenameModeActive: boolean;
  isOverwriteConfirmationActive: boolean;
  isDeleteConfirmationActive: boolean;
  isLoadConfirmationActive: boolean;
  pendingLoadSummary: SessionLoadSummary | null;
  pendingLoadSessionName: string;
  pendingDeleteSessionName: string;
  sessionListFocusTarget: SessionListFocusTarget;
}

export interface SessionListViewModel {
  selectedSessionIndex: number;
  selectedSession: TabManagerSession | undefined;
  previewTargetSession: TabManagerSession | undefined;
  titleText: string;
  shouldSyncSessionIndex: boolean;
}

export function createSessionTransientState(): SessionTransientState {
  return {
    isRenameModeActive: false,
    isOverwriteConfirmationActive: false,
    isDeleteConfirmationActive: false,
    isLoadConfirmationActive: false,
    pendingLoadSummary: null,
    pendingLoadSessionName: "",
    pendingDeleteSessionName: "",
    sessionListFocusTarget: "filter",
  };
}

export function resetSessionTransientState(): SessionTransientState {
  return createSessionTransientState();
}

export function withSessionListFocusTarget(
  state: SessionTransientState,
  target: SessionListFocusTarget,
): SessionTransientState {
  return {
    ...state,
    sessionListFocusTarget: target,
  };
}

export function startSessionRenameMode(state: SessionTransientState): SessionTransientState {
  return {
    ...state,
    isRenameModeActive: true,
  };
}

export function stopSessionRenameMode(state: SessionTransientState): SessionTransientState {
  return {
    ...state,
    isRenameModeActive: false,
  };
}

export function startSessionOverwriteConfirmation(state: SessionTransientState): SessionTransientState {
  return {
    ...state,
    isOverwriteConfirmationActive: true,
  };
}

export function stopSessionOverwriteConfirmation(state: SessionTransientState): SessionTransientState {
  return {
    ...state,
    isOverwriteConfirmationActive: false,
  };
}

export function startSessionLoadConfirmation(
  state: SessionTransientState,
  sessionName: string,
  summary: SessionLoadSummary,
): SessionTransientState {
  return {
    ...state,
    isLoadConfirmationActive: true,
    pendingLoadSessionName: sessionName,
    pendingLoadSummary: summary,
    isDeleteConfirmationActive: false,
    pendingDeleteSessionName: "",
  };
}

export function stopSessionLoadConfirmation(state: SessionTransientState): SessionTransientState {
  return {
    ...state,
    isLoadConfirmationActive: false,
    pendingLoadSummary: null,
    pendingLoadSessionName: "",
  };
}

export function startSessionDeleteConfirmation(
  state: SessionTransientState,
  sessionName: string,
): SessionTransientState {
  return {
    ...state,
    isRenameModeActive: false,
    isLoadConfirmationActive: false,
    pendingLoadSummary: null,
    pendingLoadSessionName: "",
    isOverwriteConfirmationActive: false,
    isDeleteConfirmationActive: true,
    pendingDeleteSessionName: sessionName,
  };
}

export function stopSessionDeleteConfirmation(state: SessionTransientState): SessionTransientState {
  return {
    ...state,
    isDeleteConfirmationActive: false,
    pendingDeleteSessionName: "",
  };
}

export function hasActiveSessionConfirmation(state: SessionTransientState): boolean {
  return state.isLoadConfirmationActive
    || state.isOverwriteConfirmationActive
    || state.isDeleteConfirmationActive;
}

export function deriveSessionListViewModel(
  sessions: TabManagerSession[],
  visibleIndices: number[],
  sessionIndex: number,
  filterQuery: string,
  transientState: SessionTransientState,
): SessionListViewModel {
  const selectedSessionIndex = visibleIndices.includes(sessionIndex)
    ? sessionIndex
    : (visibleIndices[0] ?? -1);

  const selectedSession = selectedSessionIndex === -1
    ? undefined
    : sessions[selectedSessionIndex];

  const pendingDeleteSession = transientState.isDeleteConfirmationActive
    ? sessions.find((session) => session.name === transientState.pendingDeleteSessionName) || selectedSession
    : undefined;

  const previewTargetSession = pendingDeleteSession || selectedSession;

  const titleText = filterQuery.trim()
    ? `Load Sessions (${visibleIndices.length})`
    : "Load Sessions";

  return {
    selectedSessionIndex,
    selectedSession,
    previewTargetSession,
    titleText,
    shouldSyncSessionIndex: selectedSessionIndex !== sessionIndex,
  };
}
