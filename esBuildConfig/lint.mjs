import { readdirSync, readFileSync, statSync } from "fs";
import { extname, resolve, relative } from "path";

const ROOT = process.cwd();

const BANNED_UI_PACKAGES = [
  "react",
  "react-dom",
  "preact",
  "vue",
  "svelte",
  "solid-js",
  "lit",
  "@angular/core",
];

const OVERLAY_TS_FILES = [
  "src/lib/addBookmark/addBookmark.ts",
  "src/lib/bookmarks/bookmarks.ts",
  "src/lib/help/help.ts",
  "src/lib/history/history.ts",
  "src/lib/searchCurrentPage/searchCurrentPage.ts",
  "src/lib/searchOpenTabs/searchOpenTabs.ts",
  "src/lib/tabManager/session.ts",
  "src/lib/tabManager/tabManager.ts",
];

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

const PERF_INSTRUMENTATION_REQUIREMENTS = {
  "src/lib/searchOpenTabs/searchOpenTabs.ts": [
    'withPerfTrace("searchOpenTabs.applyFilter"',
  ],
  "src/lib/searchCurrentPage/searchCurrentPage.ts": [
    'withPerfTrace("searchCurrentPage.renderResults"',
    'withPerfTrace("searchCurrentPage.renderVisibleItems"',
  ],
  "src/lib/bookmarks/bookmarks.ts": [
    'withPerfTrace("bookmarks.applyFilter"',
    'withPerfTrace("bookmarks.renderVisibleItems"',
  ],
  "src/lib/history/history.ts": [
    'withPerfTrace("history.applyFilter"',
    'withPerfTrace("history.renderVisibleItems"',
  ],
};

const REQUIRED_PERF_BUDGET_KEYS = [
  "searchOpenTabs.applyFilter",
  "searchCurrentPage.renderResults",
  "searchCurrentPage.renderVisibleItems",
  "bookmarks.applyFilter",
  "bookmarks.renderVisibleItems",
  "history.applyFilter",
  "history.renderVisibleItems",
];

const errors = [];

function readText(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

function walkFiles(dir, extensions, out = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkFiles(fullPath, extensions, out);
      continue;
    }
    if (extensions.has(extname(entry))) out.push(fullPath);
  }
  return out;
}

function isBannedPackage(name) {
  return BANNED_UI_PACKAGES.some((pkg) => name === pkg || name.startsWith(`${pkg}/`));
}

function checkPackageDependencies() {
  const packageJson = JSON.parse(readText("package.json"));
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = packageJson[section] || {};
    for (const depName of Object.keys(deps)) {
      if (isBannedPackage(depName)) {
        errors.push(`package.json ${section} includes banned UI dependency "${depName}".`);
      }
    }
  }
}

function checkSourceImports() {
  const tsFiles = walkFiles(resolve(ROOT, "src"), new Set([".ts"]));
  const importPattern =
    /(?:import|export)\s[^"']*?\sfrom\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;

  for (const fullPath of tsFiles) {
    const relPath = relative(ROOT, fullPath);
    const source = readFileSync(fullPath, "utf8");
    let match;
    while ((match = importPattern.exec(source)) !== null) {
      const imported = match[1] || match[2] || match[3];
      if (!imported || imported.startsWith(".") || imported.startsWith("/")) continue;
      if (isBannedPackage(imported)) {
        errors.push(`${relPath} imports banned UI module "${imported}".`);
      }
    }
  }
}

function checkOverlayContracts() {
  for (const file of OVERLAY_TS_FILES) {
    const source = readText(file);
    if (!source.includes("createPanelHost(")) {
      errors.push(`${file} must create overlays through createPanelHost().`);
    }
    if (!source.includes("getBaseStyles()")) {
      errors.push(`${file} must compose styles from getBaseStyles().`);
    }
    if (!source.includes("registerPanelCleanup(")) {
      errors.push(`${file} must register panel cleanup to avoid listener leaks.`);
    }
  }
}

function checkUiGlitchBaseline() {
  for (const file of OVERLAY_CSS_FILES) {
    const css = readText(file);
    if (!css.includes("backface-visibility: hidden")) {
      errors.push(`${file} must set backface-visibility: hidden on its panel container.`);
    }
    if (!css.includes("will-change: transform")) {
      errors.push(`${file} must set will-change: transform on its panel container.`);
    }
    if (!css.includes("contain: layout style paint")) {
      errors.push(`${file} must set contain: layout style paint on its panel container.`);
    }
    if (!css.includes("overscroll-behavior: contain")) {
      errors.push(`${file} must set overscroll-behavior: contain on its panel container.`);
    }
    if (!css.includes("@media (max-width:")) {
      errors.push(`${file} must include a responsive @media (max-width: ...) rule.`);
    }
    if (!css.includes("var(--ht-color-")) {
      errors.push(`${file} must consume shared panelHost design tokens (var(--ht-color-*)).`);
    }
  }

  const panelHost = readText("src/lib/shared/panelHost.ts");
  if (!panelHost.includes("requestAnimationFrame")) {
    errors.push("src/lib/shared/panelHost.ts must reclaim focus through requestAnimationFrame.");
  }
  if (!panelHost.includes("activePanelCleanup")) {
    errors.push("src/lib/shared/panelHost.ts must keep single-panel cleanup state.");
  }
  if (!panelHost.includes("100dvh") || !panelHost.includes("100dvw")) {
    errors.push("src/lib/shared/panelHost.ts must use dynamic viewport units (100dvw/100dvh).");
  }
  if (!panelHost.includes("--ht-color-bg") || !panelHost.includes("--ht-color-accent")) {
    errors.push("src/lib/shared/panelHost.ts must define shared color tokens.");
  }
}

function checkContributorDocs() {
  const readme = readText("README.md");
  const contributing = readText("CONTRIBUTING.md");
  if (!readme.includes("docs/ARCHITECTURE.md")) {
    errors.push("README.md must reference docs/ARCHITECTURE.md for contributor onboarding.");
  }
  if (!contributing.includes("docs/ARCHITECTURE.md")) {
    errors.push("CONTRIBUTING.md must reference docs/ARCHITECTURE.md.");
  }
}

function checkPerfGuardrails() {
  const perfShared = readText("src/lib/shared/perf.ts");
  if (!perfShared.includes("export function withPerfTrace")) {
    errors.push("src/lib/shared/perf.ts must expose withPerfTrace().");
  }

  const perfBudgets = JSON.parse(readText("src/lib/shared/perfBudgets.json"));
  for (const key of REQUIRED_PERF_BUDGET_KEYS) {
    if (typeof perfBudgets[key] !== "number" || perfBudgets[key] <= 0) {
      errors.push(`src/lib/shared/perfBudgets.json must define a positive budget for "${key}".`);
    }
  }

  for (const [file, needles] of Object.entries(PERF_INSTRUMENTATION_REQUIREMENTS)) {
    const source = readText(file);
    for (const needle of needles) {
      if (!source.includes(needle)) {
        errors.push(`${file} must include perf instrumentation: ${needle}`);
      }
    }
  }
}

checkPackageDependencies();
checkSourceImports();
checkOverlayContracts();
checkUiGlitchBaseline();
checkContributorDocs();
checkPerfGuardrails();

if (errors.length > 0) {
  console.error("[lint] FAILED");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("[lint] OK");
console.log(`- Checked overlay modules: ${OVERLAY_TS_FILES.length}`);
console.log(`- Checked overlay styles: ${OVERLAY_CSS_FILES.length}`);
console.log(`- Banned UI packages: ${BANNED_UI_PACKAGES.length}`);
