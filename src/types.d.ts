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
  navigationMode: "basic" | "vim";
  bindings: {
    global: Record<string, KeyBinding>;
    tabManager: Record<string, KeyBinding>;
    search: Record<string, KeyBinding>;
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

// Browser bookmark entry for the bookmarks overlay
interface BookmarkEntry {
  id: string;
  url: string;
  title: string;
  dateAdded?: number;      // timestamp when bookmark was created
  parentId?: string;       // folder ID the bookmark belongs to
  parentTitle?: string;    // folder name the bookmark belongs to
  folderPath?: string;     // full path: "Bookmarks Menu › Work › Projects"
  usageScore?: number;     // computed from bookmark usage tracking
}

// Bookmark usage tracking data (persisted per URL)
interface BookmarkUsage {
  visitCount: number;
  lastVisit: number;  // timestamp
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
}
