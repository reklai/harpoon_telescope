import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function readText(pathFromRoot) {
  return readFileSync(resolve(ROOT, pathFromRoot), "utf8");
}

const SPLIT_LAYOUT_FILES = [
  "src/lib/searchCurrentPage/searchCurrentPage.css",
  "src/lib/bookmarks/bookmarks.css",
];

const SINGLE_PANEL_FILES = [
  "src/lib/searchOpenTabs/searchOpenTabs.css",
  "src/lib/tabManager/tabManager.css",
  "src/lib/tabManager/session.css",
  "src/lib/addBookmark/addBookmark.css",
  "src/lib/help/help.css",
];

test("split overlays stack into vertical layout on narrow viewports", () => {
  for (const file of SPLIT_LAYOUT_FILES) {
    const css = readText(file);
    assert.match(css, /@media \(max-width:\s*860px\)/, `${file} missing 860px responsive media query`);
    assert.match(css, /flex-direction:\s*column/, `${file} must stack columns on small screens`);
    assert.match(css, /width:\s*100%/, `${file} must expand panes to full width on small screens`);
  }
});

test("all overlays include mobile tightening for small devices", () => {
  for (const file of [...SPLIT_LAYOUT_FILES, ...SINGLE_PANEL_FILES]) {
    const css = readText(file);
    assert.match(css, /@media \(max-width:/, `${file} missing responsive media query`);
  }
});

test("single-panel overlays reduce corner radius on compact screens", () => {
  for (const file of SINGLE_PANEL_FILES) {
    const css = readText(file);
    assert.match(css, /border-radius:\s*8px/, `${file} should tighten radius in compact media query`);
  }
});
