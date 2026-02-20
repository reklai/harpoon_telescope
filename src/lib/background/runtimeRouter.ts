import browser from "webextension-polyfill";
import { BackgroundRuntimeMessage } from "../shared/runtimeMessages";

export const UNHANDLED = Symbol("background-runtime-unhandled");
export type RuntimeMessageResult = unknown | typeof UNHANDLED;

export type RuntimeMessageHandler = (
  message: BackgroundRuntimeMessage,
  sender: browser.Runtime.MessageSender,
) => Promise<RuntimeMessageResult>;

export function registerRuntimeMessageRouter(
  handlers: RuntimeMessageHandler[],
): void {
  browser.runtime.onMessage.addListener(async (msg: unknown, sender: browser.Runtime.MessageSender) => {
    const message = msg as BackgroundRuntimeMessage;
    for (const handler of handlers) {
      const result = await handler(message, sender);
      if (result !== UNHANDLED) {
        return result;
      }
    }
    return null;
  });
}
