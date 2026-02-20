import browser from "webextension-polyfill";
import { TabManagerDomain } from "./tabManagerDomain";
import { RuntimeMessageHandler, UNHANDLED } from "./runtimeRouter";

export function createTabManagerMessageHandler(
  domain: TabManagerDomain,
): RuntimeMessageHandler {
  return async (message, sender) => {
    switch (message.type) {
      case "TAB_MANAGER_ADD": {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab) return { ok: false, reason: "No active tab" };
        return await domain.add(tab);
      }

      case "TAB_MANAGER_REMOVE":
        await domain.remove(message.tabId);
        return { ok: true };

      case "TAB_MANAGER_LIST":
        await domain.reconcile();
        return domain.list();

      case "TAB_MANAGER_JUMP":
        await domain.jump(message.slot);
        return { ok: true };

      case "TAB_MANAGER_CYCLE":
        return await domain.cycle(message.direction);

      case "TAB_MANAGER_SAVE_SCROLL":
        await domain.saveCurrentTabScroll();
        return { ok: true };

      case "TAB_MANAGER_REORDER":
        await domain.reorder(message.list);
        return { ok: true };

      case "CONTENT_SCRIPT_READY": {
        const tabId = sender.tab?.id;
        if (tabId == null) return { ok: true };

        const pending = domain.consumePendingScrollRestore(tabId);
        if (pending) {
          browser.tabs.sendMessage(tabId, {
            type: "SET_SCROLL",
            scrollX: pending.scrollX,
            scrollY: pending.scrollY,
          }).catch(() => {});
        }
        return { ok: true };
      }

      default:
        return UNHANDLED;
    }
  };
}
