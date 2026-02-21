import browser, { Tabs } from "webextension-polyfill";
import { ContentRuntimeMessage } from "../shared/runtimeMessages";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendContentMessageWithRetry(
  tabId: number,
  message: ContentRuntimeMessage,
): Promise<boolean> {
  const retryDelaysMs = [0, 80, 220, 420];
  for (const delay of retryDelaysMs) {
    if (delay > 0) await sleep(delay);
    try {
      await browser.tabs.sendMessage(tabId, message);
      return true;
    } catch (_) {
      // Content script may be initializing after tab restore/activation.
    }
  }
  return false;
}

export function registerCommandRouter(deps: CommandRouterDeps): void {
  browser.commands.onCommand.addListener(async (command: string) => {
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || activeTab.id == null) return;

    if (command === "open-search-current") {
      await sendContentMessageWithRetry(activeTab.id, { type: "OPEN_SEARCH_CURRENT_PAGE" });
      return;
    }

    if (command === "open-tab-manager") {
      await sendContentMessageWithRetry(activeTab.id, { type: "OPEN_TAB_MANAGER" });
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
