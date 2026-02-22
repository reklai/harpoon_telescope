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

test("contributor docs reference release/store/privacy docs", () => {
  const contributing = readText("CONTRIBUTING.md");
  assert.ok(contributing.includes("RELEASE.md"));
  assert.ok(contributing.includes("STORE.md"));
  assert.ok(contributing.includes("PRIVACY.md"));
});

test("store and privacy docs match current slot/session limits", () => {
  const store = readText("STORE.md");
  const privacy = readText("PRIVACY.md");

  assert.ok(store.includes("Anchor up to 4 tabs to numbered slots."));
  assert.ok(store.includes("Keep up to 4 sessions."));
  assert.ok(privacy.includes("Harpoon list") && privacy.includes("(up to 4)"));
  assert.ok(privacy.includes("Saved sessions") && privacy.includes("(up to 4)"));
});

test("store docs point frecency shortcut to Alt+Shift+F", () => {
  const store = readText("STORE.md");
  assert.ok(store.includes("Press Alt+Shift+F"));
});
