import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = process.cwd();

function readText(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

const OVERLAY_CSS_FILES = [
  "src/lib/addBookmark/addBookmark.css",
  "src/lib/bookmarks/bookmarks.css",
  "src/lib/help/help.css",
  "src/lib/history/history.css",
  "src/lib/searchCurrentPage/searchCurrentPage.css",
  "src/lib/searchOpenTabs/searchOpenTabs.css",
  "src/lib/tabManager/session.css",
  "src/lib/tabManager/tabManager.css",
];

test("README documents engineering promise", () => {
  const readme = readText("README.md");
  assert.match(readme, /## Engineering Promise/);
  assert.match(readme, /Ghostty-inspired UX/);
  assert.match(readme, /Native browser primitives first/);
  assert.match(readme, /Cross-platform parity/);
  assert.match(readme, /Minimal UI glitching/);
});

test("learn guide references engineering promise", () => {
  const learn = readText("learn.md");
  assert.match(learn, /Engineering promise:/);
  assert.match(learn, /Ghostty-inspired/);
  assert.match(learn, /browser-primitive/);
  assert.match(learn, /minimize visual glitching/);
});

test("package scripts expose engineering guardrail chain", () => {
  const packageJson = JSON.parse(readText("package.json"));
  assert.equal(packageJson.scripts.lint, "node esBuildConfig/lint.mjs");
  assert.equal(packageJson.scripts.test, "node --test test/*.test.mjs");
  assert.match(packageJson.scripts.ci, /\bnpm run lint\b/);
  assert.match(packageJson.scripts.ci, /\bnpm run test\b/);
  assert.match(packageJson.scripts.ci, /\bnpm run verify:compat\b/);
});

test("overlay css includes anti-glitch container baseline", () => {
  for (const file of OVERLAY_CSS_FILES) {
    const css = readText(file);
    assert.match(css, /backface-visibility:\s*hidden/);
    assert.match(css, /will-change:\s*transform/);
  }
});
