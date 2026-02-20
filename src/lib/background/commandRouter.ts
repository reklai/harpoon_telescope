import browser, { Tabs } from "webextension-polyfill";

interface CommandRouterDeps {
  addTabManagerEntry(tab: Tabs.Tab): Promise<{ ok: boolean; reason?: string; slot?: number }>;
  jumpToSlot(slot: number): Promise<void>;
}

const TAB_MANAGER_SLOT_COMMANDS: Record<string, number> = {
  "tab-manager-tab-1": 1,
  "tab-manager-tab-2": 2,
  "tab-manager-tab-3": 3,
  "tab-manager-tab-4": 4,
};

export function registerCommandRouter(deps: CommandRouterDeps): void {
  browser.commands.onCommand.addListener(async (command: string) => {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || activeTab.id == null) return;

    if (command === "open-search-current") {
      try {
        await browser.tabs.sendMessage(activeTab.id, { type: "OPEN_SEARCH_CURRENT_PAGE" });
      } catch (_) {
        // No-op if content script is unavailable.
      }
      return;
    }

    if (command === "open-tab-manager") {
      try {
        await browser.tabs.sendMessage(activeTab.id, { type: "OPEN_TAB_MANAGER" });
      } catch (_) {
        // No-op if content script is unavailable.
      }
      return;
    }

    if (command === "tab-manager-add") {
      await deps.addTabManagerEntry(activeTab);
      return;
    }

    const slot = TAB_MANAGER_SLOT_COMMANDS[command];
    if (slot) {
      await deps.jumpToSlot(slot);
    }
  });
}
