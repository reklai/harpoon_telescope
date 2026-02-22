import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function readText(pathFromRoot) {
  return readFileSync(resolve(root, pathFromRoot), "utf8");
}

test("background runtime entry composes handlers/domains/lifecycle modules", () => {
  const source = readText("src/entryPoints/backgroundRuntime/background.ts");

  assert.match(source, /from "\.\.\/\.\.\/lib\/backgroundRuntime\/handlers\/commandRouter"/);
  assert.match(source, /from "\.\.\/\.\.\/lib\/backgroundRuntime\/handlers\/runtimeRouter"/);
  assert.match(source, /from "\.\.\/\.\.\/lib\/backgroundRuntime\/handlers\/sessionMessageHandler"/);
  assert.match(source, /from "\.\.\/\.\.\/lib\/backgroundRuntime\/handlers\/tabManagerMessageHandler"/);
  assert.match(source, /from "\.\.\/\.\.\/lib\/backgroundRuntime\/domains\/tabManagerDomain"/);
  assert.match(source, /from "\.\.\/\.\.\/lib\/backgroundRuntime\/lifecycle\/startupRestore"/);

  assert.match(source, /registerRuntimeMessageRouter\(\s*\[/);
  assert.match(source, /createTabManagerMessageHandler\(tabManager\)/);
  assert.match(source, /createSessionMessageHandler\(tabManager\.state\)/);
  assert.match(source, /miscMessageHandler/);

  assert.match(source, /registerStartupRestore\(/);
  assert.match(source, /clearTabManager:\s*async\s*\(\)\s*=>\s*await tabManager\.clearAll\(\)/);
});

test("session runtime handler preserves save-load-delete-rename routing", () => {
  const source = readText("src/lib/backgroundRuntime/handlers/sessionMessageHandler.ts");

  assert.match(source, /case "SESSION_SAVE":[\s\S]*sessionSave\(tabManagerState,\s*message\.name\)/);
  assert.match(source, /case "SESSION_LIST":[\s\S]*sessionList\(\)/);
  assert.match(source, /case "SESSION_LOAD_PLAN":[\s\S]*sessionLoadPlan\(tabManagerState,\s*message\.name\)/);
  assert.match(source, /case "SESSION_LOAD":[\s\S]*sessionLoad\(tabManagerState,\s*message\.name\)/);
  assert.match(source, /case "SESSION_DELETE":[\s\S]*sessionDelete\(message\.name\)/);
  assert.match(source, /case "SESSION_RENAME":[\s\S]*sessionRename\(message\.oldName,\s*message\.newName\)/);
  assert.match(source, /case "SESSION_UPDATE":[\s\S]*sessionUpdate\(tabManagerState,\s*message\.name\)/);
  assert.match(source, /case "SESSION_REPLACE":[\s\S]*sessionReplace\(tabManagerState,\s*message\.oldName,\s*message\.newName\)/);
});

test("session panel keeps save/load preflight + execution wiring", () => {
  const source = readText("src/lib/ui/panels/sessionMenu/session.ts");

  assert.match(source, /loadSessionPlanByName\(target\.name\)/);
  assert.match(source, /await loadSessionByName\(session\.name\)/);
  assert.match(source, /await saveSessionByName\(name\.trim\(\)\)/);
  assert.match(source, /await updateSession\(session\.name\)/);
  assert.match(source, /await deleteSessionByNameRemote\(name\)/);
});
