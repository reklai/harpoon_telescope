// Options page: keybinding editor with collision detection.

import {
  loadKeybindings,
  saveKeybindings,
  checkCollision,
  keyEventToString,
  keyToDisplay,
  ACTION_LABELS,
  SCOPE_LABELS,
  DEFAULT_KEYBINDINGS,
} from "../../lib/shared/keybindings";
import { escapeHtml } from "../../lib/shared/helpers";

type BindingScope = keyof KeybindingsConfig["bindings"];

interface RecordingState {
  scope: BindingScope;
  action: string;
  row: HTMLElement;
}

document.addEventListener("DOMContentLoaded", async () => {
  let config = await loadKeybindings();
  let recordingState: RecordingState | null = null;

  const container = document.getElementById("bindingsContainer")!;
  const resetAllBtn = document.getElementById("resetAllBtn")!;
  const statusBar = document.getElementById("statusBar")!;

  // Render all keybinding rows grouped by scope
  function renderBindings(): void {
    container.innerHTML = "";

    for (const [scope, actions] of Object.entries(config.bindings)) {
      const scopeLabel = SCOPE_LABELS[scope] || scope;

      const header = document.createElement("div");
      header.className = "scope-header";
      header.textContent = scopeLabel;
      container.appendChild(header);

      for (const [action, binding] of Object.entries(actions)) {
        const label = ACTION_LABELS[scope]?.[action] || action;
        const isModified = binding.key !== binding.default;

        const row = document.createElement("div");
        row.className = "binding-row";
        row.dataset.scope = scope;
        row.dataset.action = action;

        row.innerHTML = `
          <span class="binding-action">${escapeHtml(label)}</span>
          <span class="binding-key${isModified ? " modified" : ""}">${escapeHtml(keyToDisplay(binding.key))}</span>
          <button class="btn change-btn">change</button>
          <button class="btn reset-btn"${!isModified ? ' style="opacity:0.3;pointer-events:none"' : ""}>reset</button>
        `;

        const changeBtn = row.querySelector(".change-btn") as HTMLButtonElement;
        const resetBtn = row.querySelector(".reset-btn") as HTMLButtonElement;

        changeBtn.addEventListener("click", () =>
          startRecording(scope as BindingScope, action, row),
        );
        resetBtn.addEventListener("click", () =>
          resetBinding(scope as BindingScope, action),
        );

        container.appendChild(row);
      }
    }
  }

  // Enter recording mode for a specific keybinding
  function startRecording(
    scope: BindingScope,
    action: string,
    row: HTMLElement,
  ): void {
    cancelRecording();

    recordingState = { scope, action, row };
    row.classList.add("recording");

    const keyDisplay = row.querySelector(".binding-key") as HTMLElement;
    keyDisplay.textContent = "Press a key...";
    keyDisplay.classList.add("recording-indicator");

    const changeBtn = row.querySelector(".change-btn") as HTMLButtonElement;
    changeBtn.textContent = "cancel";
    changeBtn.classList.add("cancel-btn");
    changeBtn.onclick = (event: MouseEvent) => {
      event.stopPropagation();
      cancelRecording();
    };
  }

  function cancelRecording(): void {
    if (!recordingState) return;
    recordingState.row.classList.remove("recording");
    recordingState = null;
    renderBindings();
  }

  // Capture keydown while recording to assign new keybinding
  document.addEventListener(
    "keydown",
    async (event: KeyboardEvent) => {
      if (!recordingState) return;

      event.preventDefault();
      event.stopPropagation();

      const keyStr = keyEventToString(event);
      if (!keyStr) return; // modifier-only press

      const { scope, action } = recordingState;

      const collision = checkCollision(config, scope, action, keyStr);
      if (collision) {
        showStatus(
          `Conflict: "${keyToDisplay(keyStr)}" is already bound to "${collision.label}". Unbind it first.`,
          "error",
        );
        cancelRecording();
        return;
      }

      config.bindings[scope][action].key = keyStr;
      await saveKeybindings(config);
      const label = ACTION_LABELS[scope]?.[action] || action;
      showStatus(`${label} \u2192 ${keyToDisplay(keyStr)}`, "success");
      cancelRecording();
      renderBindings();
    },
    true,
  );

  // Reset a single binding back to its default
  async function resetBinding(
    scope: BindingScope,
    action: string,
  ): Promise<void> {
    const defaultKey = config.bindings[scope][action].default;

    const collision = checkCollision(config, scope, action, defaultKey);
    if (collision) {
      showStatus(
        `Conflict: default "${keyToDisplay(defaultKey)}" conflicts with "${collision.label}".`,
        "error",
      );
      return;
    }

    config.bindings[scope][action].key = defaultKey;
    await saveKeybindings(config);
    const label = ACTION_LABELS[scope]?.[action] || action;
    showStatus(
      `${label} \u2192 ${keyToDisplay(defaultKey)} (default)`,
      "success",
    );
    renderBindings();
  }

  // Reset all bindings to defaults
  resetAllBtn.addEventListener("click", async () => {
    config = JSON.parse(JSON.stringify(DEFAULT_KEYBINDINGS));
    await saveKeybindings(config);
    showStatus("All keybindings reset to defaults.", "success");
    renderBindings();
  });

  // Temporary status message at the bottom of the settings panel
  let statusTimeout: ReturnType<typeof setTimeout> | null = null;
  function showStatus(message: string, type: "success" | "error"): void {
    if (statusTimeout) clearTimeout(statusTimeout);
    statusBar.textContent = message;
    statusBar.className = `status-bar visible ${type}`;
    statusTimeout = setTimeout(() => {
      statusBar.classList.remove("visible");
    }, 3500);
  }

  renderBindings();
});
