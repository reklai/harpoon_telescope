import { sendRuntimeMessage } from "./runtimeClient";

export function notifyContentScriptReady(): Promise<void> {
  return sendRuntimeMessage<void>({ type: "CONTENT_SCRIPT_READY" });
}
