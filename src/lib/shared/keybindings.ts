// Shared keybinding configuration, defaults, collision detection, and key matching.
// Used by background, content-script, popup, and options page.

import browser from "webextension-polyfill";

export const MAX_TAB_MANAGER_SLOTS = 4;
export const MAX_SESSIONS = 4;

export const DEFAULT_KEYBINDINGS: KeybindingsConfig = {
  navigationMode: "basic",
  bindings: {
    global: {
      openTabManager:    { key: "Alt+T",       default: "Alt+T"       },
      addTab:         { key: "Alt+Shift+T", default: "Alt+Shift+T" },
      jumpSlot1:      { key: "Alt+1",       default: "Alt+1"       },
      jumpSlot2:      { key: "Alt+2",       default: "Alt+2"       },
      jumpSlot3:      { key: "Alt+3",       default: "Alt+3"       },
      jumpSlot4:      { key: "Alt+4",       default: "Alt+4"       },
      cyclePrev:      { key: "Alt+-",       default: "Alt+-"       },
      cycleNext:      { key: "Alt+=",       default: "Alt+="       },
      searchInPage:   { key: "Alt+F",       default: "Alt+F"       },
      openFrecency:   { key: "Alt+Shift+F", default: "Alt+Shift+F" },
      openBookmarks:  { key: "Alt+B",       default: "Alt+B"       },
      addBookmark:    { key: "Alt+Shift+B", default: "Alt+Shift+B" },
      openHistory:    { key: "Alt+Y",       default: "Alt+Y"       },
      openHelp:       { key: "Alt+M",       default: "Alt+M"       },
      toggleVim:      { key: "Alt+V",       default: "Alt+V"       },
    },
    tabManager: {
      moveUp:         { key: "ArrowUp",     default: "ArrowUp"     },
      moveDown:       { key: "ArrowDown",   default: "ArrowDown"   },
      jump:           { key: "Enter",       default: "Enter"       },
      remove:         { key: "D",           default: "D"           },
      swap:           { key: "W",           default: "W"           },
      saveSession:    { key: "S",           default: "S"           },
      loadSession:    { key: "L",           default: "L"           },
      close:          { key: "Escape",      default: "Escape"      },
    },
    search: {
      moveUp:            { key: "ArrowUp",     default: "ArrowUp"     },
      moveDown:          { key: "ArrowDown",   default: "ArrowDown"   },
      switchPane:        { key: "Tab",         default: "Tab"         },
      accept:            { key: "Enter",       default: "Enter"       },
      close:             { key: "Escape",      default: "Escape"      },
    },
  },
};

// Vim aliases layered on top of basic bindings when vim mode is active
const VIM_ENHANCED_ALIASES: Record<string, Record<string, string[]>> = {
  tabManager: {
    moveUp:   ["K"],
    moveDown: ["J"],
  },
  search: {
    moveUp:            ["K"],
    moveDown:          ["J"],
  },
};

// Display labels for the settings UI
export const ACTION_LABELS: Record<string, Record<string, string>> = {
  global: {
    openTabManager:  "Open Tab Manager panel",
    addTab:       "Add current tab",
    jumpSlot1:    "Jump to slot 1",
    jumpSlot2:    "Jump to slot 2",
    jumpSlot3:    "Jump to slot 3",
    jumpSlot4:    "Jump to slot 4",
    cyclePrev:    "Cycle to previous slot",
    cycleNext:    "Cycle to next slot",
    searchInPage: "Search in Page",
    openFrecency: "Frecency tab list",
    openBookmarks: "Bookmarks list",
    addBookmark:   "Add bookmark",
    openHistory:   "History search",
    openHelp:      "Help menu",
    toggleVim:    "Toggle vim motions",
  },
  tabManager: {
    moveUp:   "Move up",
    moveDown: "Move down",
    jump:     "Jump to tab",
    remove:   "Remove entry",
    swap:     "Swap mode",
    saveSession: "Save session",
    loadSession: "Load session",
    close:    "Close",
  },
  search: {
    moveUp:            "Move up",
    moveDown:          "Move down",
    switchPane:        "Switch pane",
    accept:            "Accept / jump",
    close:             "Close",
  },
};

export const SCOPE_LABELS: Record<string, string> = {
  global:  "Global Commands",
  tabManager: "Tab Manager Panel",
  search:  "Search Panel",
};

// -- Load / Save --

/** Load keybindings from storage, merging with defaults for forward-compatibility */
export async function loadKeybindings(): Promise<KeybindingsConfig> {
  try {
    const data = await browser.storage.local.get("keybindings");
    if (data.keybindings) {
      return mergeWithDefaults(data.keybindings as Partial<KeybindingsConfig>);
    }
  } catch (_) {
    // Storage unavailable — use defaults
  }
  return JSON.parse(JSON.stringify(DEFAULT_KEYBINDINGS));
}

export async function saveKeybindings(config: KeybindingsConfig): Promise<void> {
  await browser.storage.local.set({ keybindings: config });
}

/** Merge stored config with defaults so new actions added in updates are included */
function mergeWithDefaults(stored: Partial<KeybindingsConfig>): KeybindingsConfig {
  const merged: KeybindingsConfig = JSON.parse(
    JSON.stringify(DEFAULT_KEYBINDINGS),
  );
  merged.navigationMode = stored.navigationMode || "basic";
  for (const scope of Object.keys(merged.bindings) as Array<
    keyof KeybindingsConfig["bindings"]
  >) {
    if (!stored.bindings?.[scope]) continue;
    for (const action of Object.keys(merged.bindings[scope])) {
      const storedBinding = stored.bindings[scope]?.[action];
      if (storedBinding) {
        merged.bindings[scope][action].key = storedBinding.key;
      }
    }
  }
  return merged;
}

// -- Collision Detection --

/** Returns null if no collision, or { action, label } if the key is already bound */
export function checkCollision(
  config: KeybindingsConfig,
  scope: keyof KeybindingsConfig["bindings"],
  action: string,
  key: string,
): CollisionResult | null {
  const scopeBindings = config.bindings[scope];
  for (const [act, binding] of Object.entries(scopeBindings)) {
    if (act === action) continue;
    if (binding.key === key) {
      const label = ACTION_LABELS[scope]?.[act] || act;
      return { action: act, label };
    }
  }
  return null;
}

// -- Key Event Conversion --

/** Normalize special key names for consistent string representation */
const KEY_NAME_MAP: Record<string, string> = {
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  " ": "Space",
  Escape: "Escape",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
  Insert: "Insert",
};

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

/** Convert a KeyboardEvent into a normalized string like "Alt+F" or "Ctrl+Shift+K" */
export function keyEventToString(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");

  let keyName = e.key;
  if (KEY_NAME_MAP[keyName]) {
    keyName = KEY_NAME_MAP[keyName];
  } else if (keyName.length === 1) {
    keyName = keyName.toUpperCase();
  }

  // Modifier-only presses aren't complete combos
  if (MODIFIER_KEYS.has(keyName)) return null;

  parts.push(keyName);
  return parts.join("+");
}

// -- Key Matching --

/** Check if a KeyboardEvent matches a key string like "Alt+H" or "ArrowDown" */
export function matchesKey(e: KeyboardEvent, keyString: string): boolean {
  if (!keyString) return false;
  const parts = keyString.split("+");
  const key = parts[parts.length - 1];

  if (e.ctrlKey !== parts.includes("Ctrl")) return false;
  if (e.altKey !== parts.includes("Alt")) return false;
  if (e.shiftKey !== parts.includes("Shift")) return false;
  if (e.metaKey !== parts.includes("Meta")) return false;

  let eventKey = e.key;
  if (eventKey.length === 1) eventKey = eventKey.toUpperCase();
  if (eventKey === " ") eventKey = "Space";

  return eventKey === key;
}

/** Get all keys that trigger an action, including vim aliases when vim mode is on */
export function getKeysForAction(
  config: KeybindingsConfig,
  scope: string,
  action: string,
): string[] {
  const scopeBindings = config.bindings[scope as keyof KeybindingsConfig["bindings"]];
  const keys = [scopeBindings[action].key];
  if (config.navigationMode === "vim" && VIM_ENHANCED_ALIASES[scope]?.[action]) {
    keys.push(...VIM_ENHANCED_ALIASES[scope][action]);
  }
  return keys;
}

/** Check if a KeyboardEvent matches any key for an action (primary + vim aliases) */
export function matchesAction(
  e: KeyboardEvent,
  config: KeybindingsConfig,
  scope: string,
  action: string,
): boolean {
  const keys = getKeysForAction(config, scope, action);
  return keys.some((k) => matchesKey(e, k));
}

// -- Display Helpers --

/** Format a key string for display (replace arrow names with symbols, etc.) */
export function keyToDisplay(keyString: string): string {
  if (!keyString) return "";
  return keyString
    .replace("ArrowUp", "\u2191")
    .replace("ArrowDown", "\u2193")
    .replace("ArrowLeft", "\u2190")
    .replace("ArrowRight", "\u2192")
    .replace("Escape", "Esc")
    .replace("Delete", "Del")
    .replace("Backspace", "Bksp");
}
