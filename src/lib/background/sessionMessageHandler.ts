import {
  TabManagerState,
  sessionDelete,
  sessionList,
  sessionLoad,
  sessionRename,
  sessionSave,
  sessionUpdate,
} from "../shared/sessions";
import { RuntimeMessageHandler, UNHANDLED } from "./runtimeRouter";

export function createSessionMessageHandler(
  tabManagerState: TabManagerState,
): RuntimeMessageHandler {
  return async (message) => {
    switch (message.type) {
      case "SESSION_SAVE":
        return await sessionSave(tabManagerState, message.name);

      case "SESSION_LIST":
        return await sessionList();

      case "SESSION_LOAD":
        return await sessionLoad(tabManagerState, message.name);

      case "SESSION_DELETE":
        return await sessionDelete(message.name);

      case "SESSION_RENAME":
        return await sessionRename(message.oldName, message.newName);

      case "SESSION_UPDATE":
        return await sessionUpdate(tabManagerState, message.name);

      default:
        return UNHANDLED;
    }
  };
}
