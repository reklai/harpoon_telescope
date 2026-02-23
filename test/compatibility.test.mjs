import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function readJson(pathFromRoot) {
  return JSON.parse(readFileSync(resolve(root, pathFromRoot), "utf8"));
}

test("verifyCompat script succeeds", () => {
  const result = spawnSync(process.execPath, [resolve(root, "esBuildConfig/verifyCompat.mjs")], {
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `verifyCompat failed:\nstdout:\n${result.stdout || "(empty)"}\nstderr:\n${result.stderr || "(empty)"}`,
  );
});

test("manifests keep add-tab command shortcut aligned", () => {
  const v2 = readJson("esBuildConfig/manifest_v2.json");
  const v3 = readJson("esBuildConfig/manifest_v3.json");
  const expectedShortcut = "Alt+Shift+Y";
  assert.equal(v2.commands["tab-manager-add"].suggested_key.default, expectedShortcut);
  assert.equal(v3.commands["tab-manager-add"].suggested_key.default, expectedShortcut);
});

test("firefox manifest contains AMO gecko metadata", () => {
  const v2 = readJson("esBuildConfig/manifest_v2.json");
  const gecko = v2.browser_specific_settings?.gecko;
  assert.equal(typeof gecko?.id, "string");
  assert.ok(gecko.id.length > 0);

  const required = gecko?.data_collection_permissions?.required;
  assert.ok(Array.isArray(required), "Expected gecko.data_collection_permissions.required to be an array.");
  assert.ok(required.includes("none"), 'Expected gecko.data_collection_permissions.required to include "none".');
});
