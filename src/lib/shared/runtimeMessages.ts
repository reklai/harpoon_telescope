// Runtime message contracts between background and content scripts.

// Messages handled by contentScript listeners (sent from background).
export type ContentRuntimeMessage =
  | { type: "GET_SCROLL" }
  | { type: "SET_SCROLL"; scrollX: number; scrollY: number }
  | { type: "GREP"; query: string; filters?: SearchFilter[] }
  | { type: "GET_CONTENT" }
  | { type: "OPEN_SEARCH_CURRENT_PAGE" }
  | { type: "OPEN_TAB_MANAGER" }
  | { type: "OPEN_SESSIONS" }
  | { type: "OPEN_FRECENCY" }
  | { type: "SHOW_SESSION_RESTORE" }
  | { type: "SCROLL_TO_TEXT"; text: string }
  | {
      type: "TAB_MANAGER_ADDED_FEEDBACK";
      slot: number;
      title?: string;
      alreadyAdded?: boolean;
    }
  | { type: "TAB_MANAGER_FULL_FEEDBACK"; max: number };

// Messages handled by the background runtime listener.
export type BackgroundRuntimeMessage =
  | { type: "GREP_CURRENT"; query: string; filters?: SearchFilter[] }
  | { type: "GET_PAGE_CONTENT"; tabId: number }
  | { type: "TAB_MANAGER_ADD" }
  | { type: "TAB_MANAGER_REMOVE"; tabId: number }
  | { type: "TAB_MANAGER_LIST" }
  | { type: "TAB_MANAGER_JUMP"; slot: number }
  | { type: "TAB_MANAGER_CYCLE"; direction: "prev" | "next" }
  | { type: "TAB_MANAGER_SAVE_SCROLL" }
  | { type: "TAB_MANAGER_REORDER"; list: TabManagerEntry[] }
  | { type: "GET_CURRENT_TAB" }
  | { type: "GET_KEYBINDINGS" }
  | { type: "SAVE_KEYBINDINGS"; config: KeybindingsConfig }
  | { type: "SWITCH_TO_TAB"; tabId: number }
  | { type: "FRECENCY_LIST" }
  | { type: "CONTENT_SCRIPT_READY" }
  | { type: "SESSION_SAVE"; name: string }
  | { type: "SESSION_LIST" }
  | { type: "SESSION_LOAD_PLAN"; name: string }
  | { type: "SESSION_LOAD"; name: string }
  | { type: "SESSION_DELETE"; name: string }
  | { type: "SESSION_RENAME"; oldName: string; newName: string }
  | { type: "SESSION_UPDATE"; name: string }
  | { type: "SESSION_REPLACE"; oldName: string; newName: string };
