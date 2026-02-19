// Shared project type declarations

// Harpoon entry stored in extension state
interface HarpoonEntry {
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
    harpoon: Record<string, KeyBinding>;
    search: Record<string, KeyBinding>;
  };
}

// Structural search filters for telescope grep
type SearchFilter = "code" | "headings" | "links";

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

// Saved harpoon session (detach/attach)
interface HarpoonSessionEntry {
  url: string;
  title: string;
  scrollX: number;
  scrollY: number;
}

interface HarpoonSession {
  name: string;
  entries: HarpoonSessionEntry[];
  savedAt: number;  // timestamp
}

// Browser history entry for the history overlay
interface HistoryEntry {
  url: string;
  title: string;
  lastVisitTime: number;
  visitCount: number;
}
