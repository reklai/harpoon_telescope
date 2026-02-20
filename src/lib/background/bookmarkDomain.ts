import browser from "webextension-polyfill";

interface BookmarkFolder {
  id: string;
  title: string;
  depth: number;
  children: BookmarkFolder[];
}

export interface BookmarkDomain {
  list(): Promise<BookmarkEntry[]>;
  folders(): Promise<BookmarkFolder[]>;
  recordVisit(url: string): Promise<void>;
  removeUsage(url: string): Promise<void>;
}

export function createBookmarkDomain(): BookmarkDomain {
  let bookmarkUsageMap: Record<string, BookmarkUsage> = {};
  let bookmarkUsageLoaded = false;

  async function ensureBookmarkUsageLoaded(): Promise<void> {
    if (!bookmarkUsageLoaded) {
      const data = await browser.storage.local.get("bookmarkUsage");
      bookmarkUsageMap = (data.bookmarkUsage as Record<string, BookmarkUsage>) || {};
      bookmarkUsageLoaded = true;
    }
  }

  async function saveBookmarkUsage(): Promise<void> {
    await browser.storage.local.set({ bookmarkUsage: bookmarkUsageMap });
  }

  function computeBookmarkUsageScore(usage: BookmarkUsage): number {
    if (!usage) return 0;
    const ageMs = Date.now() - usage.lastVisit;
    const ageMin = ageMs / 60000;
    let weight: number;
    if (ageMin < 240) weight = 100;
    else if (ageMin < 1440) weight = 70;
    else if (ageMin < 10080) weight = 50;
    else if (ageMin < 43200) weight = 30;
    else weight = 10;
    return Math.round(usage.visitCount * weight);
  }

  async function recordVisit(url: string): Promise<void> {
    await ensureBookmarkUsageLoaded();
    const existing = bookmarkUsageMap[url];
    if (existing) {
      existing.visitCount += 1;
      existing.lastVisit = Date.now();
    } else {
      bookmarkUsageMap[url] = { visitCount: 1, lastVisit: Date.now() };
    }
    await saveBookmarkUsage();
  }

  async function list(): Promise<BookmarkEntry[]> {
    await ensureBookmarkUsageLoaded();

    const tree = await browser.bookmarks.getTree();
    const results: BookmarkEntry[] = [];

    function walk(
      nodes: browser.Bookmarks.BookmarkTreeNode[],
      parentTitle?: string,
      parentPath?: string,
      parentId?: string,
    ): void {
      for (const node of nodes) {
        if (node.url) {
          const usage = bookmarkUsageMap[node.url];
          results.push({
            id: node.id,
            url: node.url,
            title: node.title || "",
            dateAdded: node.dateAdded,
            parentId,
            parentTitle,
            folderPath: parentPath,
            usageScore: usage ? computeBookmarkUsageScore(usage) : 0,
          });
        }

        if (node.children) {
          const nextTitle = node.title || parentTitle;
          const nextPath = node.title
            ? (parentPath ? `${parentPath} > ${node.title}` : node.title)
            : parentPath;
          walk(node.children, nextTitle, nextPath, node.id);
        }
      }
    }

    walk(tree);

    results.sort((a, b) => {
      if ((a.usageScore || 0) !== (b.usageScore || 0)) {
        return (b.usageScore || 0) - (a.usageScore || 0);
      }
      return (b.dateAdded || 0) - (a.dateAdded || 0);
    });

    return results;
  }

  async function folders(): Promise<BookmarkFolder[]> {
    const tree = await browser.bookmarks.getTree();
    const rootFolders: BookmarkFolder[] = [];

    function walkInto(
      node: browser.Bookmarks.BookmarkTreeNode,
      depth: number,
      target: BookmarkFolder[],
    ): void {
      const folder: BookmarkFolder = {
        id: node.id,
        title: node.title || "(unnamed)",
        depth,
        children: [],
      };
      if (node.children) {
        for (const child of node.children) {
          if (!child.url && child.children) {
            walkInto(child, depth + 1, folder.children);
          }
        }
      }
      target.push(folder);
    }

    function walk(nodes: browser.Bookmarks.BookmarkTreeNode[], depth: number): void {
      for (const node of nodes) {
        if (!node.url && node.children) {
          const folder: BookmarkFolder = {
            id: node.id,
            title: node.title || "(root)",
            depth,
            children: [],
          };
          for (const child of node.children) {
            if (!child.url && child.children) {
              walkInto(child, depth + 1, folder.children);
            }
          }
          rootFolders.push(folder);
        }
      }
    }

    walk(tree, 0);
    return rootFolders;
  }

  async function removeUsage(url: string): Promise<void> {
    await ensureBookmarkUsageLoaded();
    if (!(url in bookmarkUsageMap)) return;
    delete bookmarkUsageMap[url];
    await saveBookmarkUsage();
  }

  return {
    list,
    folders,
    recordVisit,
    removeUsage,
  };
}
