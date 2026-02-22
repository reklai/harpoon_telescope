import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function readText(pathFromRoot) {
  return readFileSync(resolve(ROOT, pathFromRoot), "utf8");
}

function readJson(pathFromRoot) {
  return JSON.parse(readText(pathFromRoot));
}

const budgets = readJson("src/lib/shared/perfBudgets.json");

const REQUIRED_BUDGETS = {
  "searchOpenTabs.applyFilter": 20,
  "searchCurrentPage.renderResults": 30,
  "searchCurrentPage.renderVisibleItems": 16,
};

const REQUIRED_INSTRUMENTATION = {
  "src/lib/searchOpenTabs/searchOpenTabs.ts": ['withPerfTrace("searchOpenTabs.applyFilter"'],
  "src/lib/searchCurrentPage/searchCurrentPage.ts": [
    'withPerfTrace("searchCurrentPage.renderResults"',
    'withPerfTrace("searchCurrentPage.renderVisibleItems"',
  ],
};

function buildFuzzyPattern(query) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const pattern = terms
    .map((term) => term.split("").map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^]*?"))
    .join("[^]*?");
  return new RegExp(pattern, "i");
}

function scoreMatch(lowerText, rawText, queryLower, fuzzyRe) {
  if (lowerText === queryLower) return 0;
  if (lowerText.startsWith(queryLower)) return 1;
  if (lowerText.includes(queryLower)) return 2;
  if (fuzzyRe.test(rawText)) return 3;
  return -1;
}

function runOpenTabsStyleFilter(entries, query) {
  const trimmed = query.trim();
  if (!trimmed) return entries;

  const re = buildFuzzyPattern(trimmed);
  if (!re) return entries;
  const substringRe = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const lowerQuery = trimmed.toLowerCase();

  const ranked = [];
  for (const entry of entries) {
    const title = entry.title || "";
    const url = entry.url || "";
    if (!(substringRe.test(title) || substringRe.test(url) || re.test(title) || re.test(url))) continue;

    const titleScore = scoreMatch(title.toLowerCase(), title, lowerQuery, re);
    const urlScore = scoreMatch(url.toLowerCase(), url, lowerQuery, re);
    ranked.push({
      entry,
      titleScore,
      titleHit: titleScore >= 0,
      titleLen: title.length,
      urlScore,
      urlHit: urlScore >= 0,
    });
  }

  ranked.sort((a, b) => {
    if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
    if (a.titleHit && b.titleHit) {
      if (a.titleScore !== b.titleScore) return a.titleScore - b.titleScore;
      return a.titleLen - b.titleLen;
    }
    if (a.urlHit !== b.urlHit) return a.urlHit ? -1 : 1;
    if (a.urlHit && b.urlHit) return a.urlScore - b.urlScore;
    return 0;
  });

  return ranked.map((item) => item.entry);
}

test("perf budgets stay within capped thresholds", () => {
  for (const [key, maxMs] of Object.entries(REQUIRED_BUDGETS)) {
    assert.equal(typeof budgets[key], "number", `Missing perf budget: ${key}`);
    assert.ok(budgets[key] > 0, `Perf budget must be positive: ${key}`);
    assert.ok(
      budgets[key] <= maxMs,
      `Perf budget ${key}=${budgets[key]}ms exceeds cap ${maxMs}ms`,
    );
  }
});

test("hot paths are instrumented with withPerfTrace", () => {
  for (const [file, snippets] of Object.entries(REQUIRED_INSTRUMENTATION)) {
    const source = readText(file);
    for (const snippet of snippets) {
      assert.match(source, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }
});

test("open-tabs style filter benchmark remains under regression threshold", () => {
  const entries = Array.from({ length: 3000 }, (_, index) => ({
    title: `Repository ${index} API reference ${index % 12 === 0 ? "harpoon" : "docs"}`,
    url: `https://example.com/${index % 17 === 0 ? "api" : "guide"}/${index}`,
  }));

  const query = "api har";

  // Warmup to reduce first-run variance.
  runOpenTabsStyleFilter(entries, query);
  runOpenTabsStyleFilter(entries, query);

  const start = performance.now();
  const filtered = runOpenTabsStyleFilter(entries, query);
  const elapsedMs = performance.now() - start;

  assert.ok(filtered.length > 0, "Expected benchmark query to produce matches.");

  const thresholdMs = budgets["searchOpenTabs.applyFilter"] * 15;
  assert.ok(
    elapsedMs <= thresholdMs,
    `Filter benchmark regression: ${elapsedMs.toFixed(2)}ms > ${thresholdMs}ms`,
  );
});
