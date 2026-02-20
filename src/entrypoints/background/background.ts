// Background entrypoint — composes domain handlers and runtime routers.

import browser from "webextension-polyfill";
import { recordFrecencyVisit, removeFrecencyEntry } from "../../lib/shared/frecencyScoring";
import { createBookmarkDomain } from "../../lib/background/bookmarkDomain";
import { registerCommandRouter } from "../../lib/background/commandRouter";
import { createSessionMessageHandler } from "../../lib/background/sessionMessageHandler";
import { createTabManagerDomain } from "../../lib/background/tabManagerDomain";
import { createTabManagerMessageHandler } from "../../lib/background/tabManagerMessageHandler";
import { createBookmarkMessageHandler } from "../../lib/background/bookmarkMessageHandler";
import { miscMessageHandler } from "../../lib/background/miscMessageHandler";
import { registerRuntimeMessageRouter } from "../../lib/background/runtimeRouter";
import { registerStartupRestore } from "../../lib/background/startupRestore";

const tabManager = createTabManagerDomain();
const bookmarks = createBookmarkDomain();

tabManager.registerLifecycleListeners({
  onTabClosed: async (tabId: number) => {
    await removeFrecencyEntry(tabId);
  },
  onTabActivated: async (tabId: number) => {
    try {
      const tab = await browser.tabs.get(tabId);
      await recordFrecencyVisit(tab);
    } catch (_) {
      // Tab may close before we can score it.
    }
  },
});

registerCommandRouter({
  addTabManagerEntry: async (tab) => await tabManager.add(tab),
  jumpToSlot: async (slot) => await tabManager.jump(slot),
});

registerRuntimeMessageRouter([
  createTabManagerMessageHandler(tabManager),
  createSessionMessageHandler(tabManager.state),
  createBookmarkMessageHandler(bookmarks),
  miscMessageHandler,
]);

void tabManager.ensureLoaded();
void tabManager.captureInitialActiveTab();

registerStartupRestore({
  clearTabManager: async () => await tabManager.clearAll(),
});
