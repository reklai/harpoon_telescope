// Background entrypoint — composes domain handlers and runtime routers.

import browser from "webextension-polyfill";
import { recordFrecencyVisit, removeFrecencyEntry } from "../../lib/common/utils/frecencyScoring";
import { registerCommandRouter } from "../../lib/backgroundRuntime/handlers/commandRouter";
import { createSessionMessageHandler } from "../../lib/backgroundRuntime/handlers/sessionMessageHandler";
import { createTabManagerDomain } from "../../lib/backgroundRuntime/domains/tabManagerDomain";
import { createTabManagerMessageHandler } from "../../lib/backgroundRuntime/handlers/tabManagerMessageHandler";
import { miscMessageHandler } from "../../lib/backgroundRuntime/handlers/miscMessageHandler";
import { registerRuntimeMessageRouter } from "../../lib/backgroundRuntime/handlers/runtimeRouter";
import { registerStartupRestore } from "../../lib/backgroundRuntime/lifecycle/startupRestore";
import { migrateStorageIfNeeded } from "../../lib/common/utils/storageMigrationsRuntime";

async function bootstrapBackground(): Promise<void> {
  const migration = await migrateStorageIfNeeded();
  if (migration.changed) {
    console.log(
      `[Harpoon Telescope] Storage migration applied (${migration.fromVersion} -> ${migration.toVersion}).`,
    );
  }

  const tabManager = createTabManagerDomain();
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
    miscMessageHandler,
  ]);

  void tabManager.ensureLoaded();
  void tabManager.captureInitialActiveTab();

  registerStartupRestore({
    clearTabManager: async () => await tabManager.clearAll(),
  });
}

void bootstrapBackground().catch((error) => {
  console.error("[Harpoon Telescope] Background bootstrap failed:", error);
});
