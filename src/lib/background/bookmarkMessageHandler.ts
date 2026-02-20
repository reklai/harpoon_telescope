import browser from "webextension-polyfill";
import { BookmarkDomain } from "./bookmarkDomain";
import { RuntimeMessageHandler, UNHANDLED } from "./runtimeRouter";

export function createBookmarkMessageHandler(
  bookmarks: BookmarkDomain,
): RuntimeMessageHandler {
  return async (message) => {
    switch (message.type) {
      case "BOOKMARK_LIST":
        return await bookmarks.list();

      case "OPEN_BOOKMARK_TAB": {
        const url = message.url;
        try {
          const tabs = await browser.tabs.query({ currentWindow: true });
          const existing = tabs.find((tab) => tab.url === url);
          if (existing?.id != null) {
            await browser.tabs.update(existing.id, { active: true });
          } else {
            await browser.tabs.create({ url, active: true });
          }
          await bookmarks.recordVisit(url);
        } catch (_) {
          // Best effort open.
        }
        return { ok: true };
      }

      case "BOOKMARK_ADD": {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) return { ok: false, reason: "No active tab" };

        try {
          const options: browser.Bookmarks.CreateDetails = {
            url: tab.url,
            title: tab.title || tab.url,
          };
          if (message.parentId) {
            options.parentId = message.parentId;
          }
          const created = await browser.bookmarks.create(options);
          return { ok: true, id: created.id, title: tab.title };
        } catch (_) {
          return { ok: false, reason: "Failed to create bookmark" };
        }
      }

      case "BOOKMARK_REMOVE":
        try {
          await browser.bookmarks.remove(message.id as string);
          if (message.url) {
            await bookmarks.removeUsage(message.url);
          }
          return { ok: true };
        } catch (_) {
          return { ok: false, reason: "Failed to remove bookmark" };
        }

      case "BOOKMARK_REMOVE_TREE":
        try {
          await browser.bookmarks.removeTree(message.id);
          return { ok: true };
        } catch (_) {
          return { ok: false, reason: "Failed to remove folder" };
        }

      case "BOOKMARK_FOLDERS":
        return await bookmarks.folders();

      case "BOOKMARK_CREATE_FOLDER":
        try {
          const options: browser.Bookmarks.CreateDetails = { title: message.title };
          if (message.parentId) {
            options.parentId = message.parentId;
          }
          const created = await browser.bookmarks.create(options);
          return { ok: true, title: message.title, id: created.id };
        } catch (_) {
          return { ok: false, reason: "Failed to create folder" };
        }

      case "BOOKMARK_MOVE":
        try {
          const destination: { parentId?: string; index?: number } = {};
          if (message.parentId) destination.parentId = message.parentId;
          await browser.bookmarks.move(message.id, destination);
          return { ok: true };
        } catch (_) {
          return { ok: false, reason: "Failed to move bookmark" };
        }

      default:
        return UNHANDLED;
    }
  };
}
