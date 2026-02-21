import browser from "webextension-polyfill";
import { loadKeybindings, saveKeybindings } from "../shared/keybindings";
import { getFrecencyList } from "../shared/frecencyScoring";
import { grepCurrentTab, getPageContent } from "./pageSearchDomain";
import { RuntimeMessageHandler, UNHANDLED } from "./runtimeRouter";

export const miscMessageHandler: RuntimeMessageHandler = async (message) => {
  switch (message.type) {
    case "GREP_CURRENT":
      return await grepCurrentTab(message.query, message.filters || []);

    case "GET_PAGE_CONTENT":
      return await getPageContent(message.tabId);

    case "GET_CURRENT_TAB": {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    }

    case "GET_KEYBINDINGS":
      return await loadKeybindings();

    case "SAVE_KEYBINDINGS":
      await saveKeybindings(message.config);
      return { ok: true };

    case "SWITCH_TO_TAB":
      try {
        await browser.tabs.update(message.tabId, { active: true });
      } catch (_) {
        // Best effort switch.
      }
      return { ok: true };

    case "FRECENCY_LIST":
      return await getFrecencyList();

    default:
      return UNHANDLED;
  }
};
