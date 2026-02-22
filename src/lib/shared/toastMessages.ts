function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export const toastMessages = {
  panelOpenFailed: "Panel failed to open",
  pageTooLargeToSearch: "Page too large to search",

  tabManagerActionFailed: "Tab Manager action failed",
  tabManagerSwapFailed: "Swap failed",
  tabManagerJumpFailed: "Jump failed",
  tabManagerAdded: (slot: number): string => `Added to Tab Manager [${slot}]`,
  tabManagerAlreadyAdded: (slot: number): string => `Already in Tab Manager [${slot}]`,
  tabManagerFull: (max: number): string => `Tab Manager full (max ${max})`,

  sessionMenuFailed: "Session menu failed",
  alreadyUsingSavedSessionFromList: (name: string): string =>
    `No changes to save, already saved as "${name}"`,

  sessionLoadPlanFailed: "Failed to prepare session load",
  sessionNotFound: "Session not found",
  sessionSaveFailed: "Save session failed",
  sessionSaveReopenRequired: "Session state changed, reopen Save Session and try again",
  sessionSave: (name: string): string => `Saved session "${name}"`,
  sessionSaveReplacing: (name: string, replacedName: string): string =>
    `Saved session "${name}" (replaced "${replacedName}")`,
  sessionLoad: (name: string, count: number): string =>
    `Loaded session "${name}" (${count} ${pluralize(count, "tab")})`,
  sessionRename: (name: string): string => `Renamed session "${name}"`,
  sessionRenameFailed: "Rename failed",
  sessionOverwrite: (name: string): string => `Overwrote session "${name}"`,
  sessionOverwriteFailed: "Overwrite failed",
  sessionRestore: (name: string, count: number): string =>
    `Restored session "${name}" (${count} ${pluralize(count, "tab")})`,
};
