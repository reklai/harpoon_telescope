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

test("keybinding loader merges legacy stored config with defaults", () => {
  const source = readText("src/lib/shared/keybindings.ts");

  assert.match(source, /browser\.storage\.local\.get\("keybindings"\)/);
  assert.match(source, /return mergeWithDefaults\(data\.keybindings as Partial<KeybindingsConfig>\)/);
  assert.match(source, /const merged: KeybindingsConfig = JSON\.parse\(/);
  assert.match(source, /JSON\.stringify\(DEFAULT_KEYBINDINGS\)/);
  assert.match(source, /for \(const scope of Object\.keys\(merged\.bindings\)/);
  assert.match(source, /for \(const action of Object\.keys\(merged\.bindings\[scope\]\)\)/);
});

test("stable storage keys remain backward-compatible", () => {
  const keybindings = readText("src/lib/shared/keybindings.ts");
  assert.match(keybindings, /browser\.storage\.local\.get\("keybindings"\)/);
  assert.match(keybindings, /browser\.storage\.local\.set\(\{\s*keybindings:\s*config\s*\}\)/);

  const tabManager = readText("src/lib/background/tabManagerDomain.ts");
  assert.match(tabManager, /browser\.storage\.local\.get\("tabManagerList"\)/);
  assert.match(tabManager, /browser\.storage\.local\.set\(\{\s*tabManagerList\s*\}\)/);
  assert.match(tabManager, /\(data\.tabManagerList as TabManagerEntry\[\]\) \|\| \[\]/);

  const sessions = readText("src/lib/shared/sessions.ts");
  assert.match(sessions, /browser\.storage\.local\.get\("tabManagerSessions"\)/);
  assert.match(sessions, /browser\.storage\.local\.set\(\{\s*tabManagerSessions:\s*sessions\s*\}\)/);
  assert.match(sessions, /\(stored\.tabManagerSessions as TabManagerSession\[\]\) \|\| \[\]/);

  const startupRestore = readText("src/lib/background/startupRestore.ts");
  assert.match(startupRestore, /\(stored\.tabManagerSessions as TabManagerSession\[\]\) \|\| \[\]/);
  assert.match(startupRestore, /if \(sessions\.length === 0\) return;/);

  const frecency = readText("src/lib/shared/frecencyScoring.ts");
  assert.match(frecency, /browser\.storage\.local\.get\("frecencyData"\)/);
  assert.match(frecency, /frecencyData:\s*Array\.from\(frecencyMap\.values\(\)\)/);
  assert.match(frecency, /\(data\.frecencyData as FrecencyEntry\[\]\) \|\| \[\]/);
});
