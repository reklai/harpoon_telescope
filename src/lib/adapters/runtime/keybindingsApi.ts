import { sendRuntimeMessage } from "./runtimeClient";

export function fetchKeybindings(): Promise<KeybindingsConfig> {
  return sendRuntimeMessage<KeybindingsConfig>({ type: "GET_KEYBINDINGS" });
}
