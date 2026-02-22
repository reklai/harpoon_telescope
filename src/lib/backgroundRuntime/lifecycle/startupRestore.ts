import browser from "webextension-polyfill";

interface StartupRestoreDeps {
  clearTabManager(): Promise<void>;
}

export function registerStartupRestore(deps: StartupRestoreDeps): void {
  browser.runtime.onStartup.addListener(async () => {
    const stored = await browser.storage.local.get("tabManagerSessions");
    const sessions = (stored.tabManagerSessions as TabManagerSession[]) || [];
    if (sessions.length === 0) return;

    // Tab IDs are ephemeral across browser restarts, so clear stale state first.
    await deps.clearTabManager();

    let attempts = 0;
    const tryPrompt = async (): Promise<void> => {
      attempts += 1;
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        if (attempts < 5) setTimeout(tryPrompt, 1000);
        return;
      }

      try {
        await browser.tabs.sendMessage(tab.id, { type: "SHOW_SESSION_RESTORE" });
      } catch (_) {
        if (attempts < 5) setTimeout(tryPrompt, 1000);
      }
    };

    setTimeout(tryPrompt, 1500);
  });
}
