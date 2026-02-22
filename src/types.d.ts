// Shared project type declarations

// Allow importing .css files as text (esbuild text loader)
declare module "*.css" {
  const content: string;
  export default content;
}

// Tab Manager entry stored in extension state
interface TabManagerEntry {
  tabId: number;
  url: string;
  title: string;
  scrollX: number;
  scrollY: number;
  slot: number;
  closed?: boolean;  // tab was closed but entry persists for re-opening
}

// Keybinding configuration shape
interface KeyBinding {
  key: string;
  default: string;
}

interface KeybindingsConfig {
  navigationMode: "standard";
  bindings: {
    global: Record<string, KeyBinding>;
    tabManager: Record<string, KeyBinding>;
    search: Record<string, KeyBinding>;
    session: Record<string, KeyBinding>;
  };
}

// Structural search filters for page grep
type SearchFilter = "code" | "headings" | "links" | "images";

// Grep result from content script
interface GrepResult {
  lineNumber: number;
  text: string;
  tag?: string;            // source element type (PRE, H2, A, P, etc.)
  score?: number;          // fuzzy match quality score (higher = better)
  context?: string[];      // surrounding lines for preview
  nodeRef?: WeakRef<Node>; // source DOM node for direct scroll-to
  ancestorHeading?: string; // nearest heading text above this element
  href?: string;           // link href (for A tags)
  domContext?: string[];   // context lines from same DOM parent (tag-aware)
}

// Collision detection result
interface CollisionResult {
  action: string;
  label: string;
}

// Message types passed between background and content scripts
interface ScrollData {
  scrollX: number;
  scrollY: number;
}

interface PageContent {
  text: string;
  lines: string[];
}

// Frecency tracking entry for a tab
interface FrecencyEntry {
  tabId: number;
  url: string;
  title: string;
  visitCount: number;
  lastVisit: number;  // timestamp
  frecencyScore: number;
}

// Saved tab manager session (detach/attach)
interface TabManagerSessionEntry {
  url: string;
  title: string;
  scrollX: number;
  scrollY: number;
}

interface TabManagerSession {
  name: string;
  entries: TabManagerSessionEntry[];
  savedAt: number;  // timestamp
}

interface SessionLoadSummary {
  sessionName: string;
  totalCount: number;
  replaceCount: number;
  openCount: number;
  reuseCount: number;
  slotDiffs: SessionLoadSlotDiff[];
  reuseMatches: SessionLoadReuseMatch[];
}

interface SessionLoadSlotDiff {
  slot: number;
  change: "replace" | "remove" | "add";
  currentTitle?: string;
  currentUrl?: string;
  incomingTitle?: string;
  incomingUrl?: string;
}

interface SessionLoadReuseMatch {
  slot: number;
  sessionTitle: string;
  sessionUrl: string;
  openTabTitle: string;
  openTabUrl: string;
}
