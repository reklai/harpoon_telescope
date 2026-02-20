import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadJson(file) {
  return JSON.parse(readFileSync(resolve(__dirname, file), "utf8"));
}

function hasAll(actual, required) {
  return required.every((item) => actual.includes(item));
}

function countSuggestedCommands(commands) {
  return Object.values(commands || {}).filter((command) => command?.suggested_key).length;
}

const manifestV2 = loadJson("manifest_v2.json");
const manifestV3 = loadJson("manifest_v3.json");

const errors = [];

const requiredV2Permissions = ["tabs", "activeTab", "storage", "bookmarks", "history", "<all_urls>"];
if (!hasAll(manifestV2.permissions || [], requiredV2Permissions)) {
  errors.push("MV2 is missing required permissions for runtime features.");
}

const geckoSettings = manifestV2.browser_specific_settings?.gecko;
if (!geckoSettings?.id || typeof geckoSettings.id !== "string") {
  errors.push("MV2 must declare browser_specific_settings.gecko.id for AMO signing.");
}

const requiredDataCollection = geckoSettings?.data_collection_permissions?.required;
if (!Array.isArray(requiredDataCollection) || requiredDataCollection.length === 0) {
  errors.push("MV2 must declare gecko.data_collection_permissions.required for AMO submissions.");
} else if (!requiredDataCollection.includes("none")) {
  errors.push("MV2 data_collection_permissions.required must include \"none\" for no external data collection.");
}

const requiredV3Permissions = ["tabs", "activeTab", "storage", "bookmarks", "history"];
if (!hasAll(manifestV3.permissions || [], requiredV3Permissions)) {
  errors.push("MV3 is missing required permissions for runtime features.");
}

if (!hasAll(manifestV3.host_permissions || [], ["<all_urls>"])) {
  errors.push("MV3 host_permissions must include <all_urls> for content script coverage.");
}

const suggestedCount = countSuggestedCommands(manifestV3.commands);
if (suggestedCount > 4) {
  errors.push(`MV3 declares ${suggestedCount} suggested shortcuts; Chrome allows at most 4.`);
}

const expectedAddShortcut = "Alt+Shift+T";
const v2AddShortcut = manifestV2.commands?.["tab-manager-add"]?.suggested_key?.default;
const v3AddShortcut = manifestV3.commands?.["tab-manager-add"]?.suggested_key?.default;
if (v2AddShortcut !== expectedAddShortcut || v3AddShortcut !== expectedAddShortcut) {
  errors.push(`tab-manager-add suggested shortcut must be ${expectedAddShortcut} in MV2 and MV3.`);
}

if (errors.length > 0) {
  console.error("[verify:compat] FAILED");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("[verify:compat] OK");
console.log(`- MV2 permissions: ${(manifestV2.permissions || []).length}`);
console.log(`- MV3 permissions: ${(manifestV3.permissions || []).length}`);
console.log(`- MV3 suggested shortcuts: ${suggestedCount}`);
