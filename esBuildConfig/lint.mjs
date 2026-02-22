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
  "src/lib/help/help.ts",
  "src/lib/searchCurrentPage/searchCurrentPage.ts",
  "src/lib/searchOpenTabs/searchOpenTabs.ts",
  "src/lib/sessionMenu/sessionMenu.ts",
  "src/lib/tabManager/session.ts",
  "src/lib/tabManager/tabManager.ts",
];

const OVERLAY_CSS_FILES = [
  "src/lib/help/help.css",
  "src/lib/searchCurrentPage/searchCurrentPage.css",
  "src/lib/searchOpenTabs/searchOpenTabs.css",
  "src/lib/sessionMenu/sessionMenu.css",
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
};

const REQUIRED_PERF_BUDGET_KEYS = [
  "searchOpenTabs.applyFilter",
  "searchCurrentPage.renderResults",
  "searchCurrentPage.renderVisibleItems",
];

const DISALLOWED_IDENTIFIER_PATTERNS = [
  {
    pattern: /\b(?:const|let|var)\s+msg\b/g,
    message: 'Use a descriptive name instead of "msg" for payload objects.',
  },
  {
    pattern: /\bfunction\s+\w+\s*\(\s*msg\s*:/g,
    message: 'Use a descriptive name instead of "msg" for function parameters.',
  },
  {
    pattern: /\(\s*msg\s*:\s*[^)]*\)\s*=>/g,
    message: 'Use a descriptive name instead of "msg" for arrow-function parameters.',
  },
  {
    pattern: /\bfunction\s+\w+\s*\(\s*e\s*:\s*(?:KeyboardEvent|MouseEvent|FocusEvent|WheelEvent|Event)\b/g,
    message: 'Use "event" instead of "e" for event-handler parameters.',
  },
  {
    pattern: /addEventListener\(\s*["'][^"']+["']\s*,\s*\(\s*e\b/g,
    message: 'Use "event" instead of "e" for addEventListener callback parameters.',
  },
];

const CAMEL_CASE_NAME = /^[a-z][a-zA-Z0-9]*$/;
const FUNCTION_DECLARATION_PATTERN = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

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

function getLineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function stripFileExtension(filename) {
  if (filename.endsWith(".d.ts")) return filename.slice(0, -".d.ts".length);
  const extension = extname(filename);
  return extension ? filename.slice(0, -extension.length) : filename;
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

function checkPathNamingConventions() {
  const libRoot = resolve(ROOT, "src/lib");
  const entryPointsRoot = resolve(ROOT, "src/entryPoints");

  function walkNaming(rootPath, namingPattern, scopeLabel) {
    for (const entry of readdirSync(rootPath)) {
      const fullPath = resolve(rootPath, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (!namingPattern.test(entry)) {
          errors.push(`${relative(ROOT, fullPath)} must use ${scopeLabel} naming.`);
        }
        walkNaming(fullPath, namingPattern, scopeLabel);
        continue;
      }
      const basename = stripFileExtension(entry);
      if (!namingPattern.test(basename)) {
        errors.push(`${relative(ROOT, fullPath)} must use ${scopeLabel} naming.`);
      }
    }
  }

  walkNaming(libRoot, CAMEL_CASE_NAME, "camelCase");
  walkNaming(entryPointsRoot, CAMEL_CASE_NAME, "camelCase");
}

function checkFunctionNamingConventions() {
  const tsFiles = [
    ...walkFiles(resolve(ROOT, "src/lib"), new Set([".ts"])),
    ...walkFiles(resolve(ROOT, "src/entryPoints"), new Set([".ts"])),
  ];
  for (const fullPath of tsFiles) {
    const relPath = relative(ROOT, fullPath);
    const source = readFileSync(fullPath, "utf8");
    FUNCTION_DECLARATION_PATTERN.lastIndex = 0;
    let match;
    while ((match = FUNCTION_DECLARATION_PATTERN.exec(source)) !== null) {
      const functionName = match[1];
      if (!CAMEL_CASE_NAME.test(functionName)) {
        const line = getLineNumber(source, match.index);
        errors.push(`${relPath}:${line} function "${functionName}" must use camelCase naming.`);
      }
    }
  }
}

function checkNamingConsistency() {
  const tsFiles = walkFiles(resolve(ROOT, "src"), new Set([".ts"]));
  for (const fullPath of tsFiles) {
    const relPath = relative(ROOT, fullPath);
    const source = readFileSync(fullPath, "utf8");
    for (const rule of DISALLOWED_IDENTIFIER_PATTERNS) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(source)) !== null) {
        const line = getLineNumber(source, match.index);
        errors.push(`${relPath}:${line} ${rule.message}`);
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
checkPathNamingConventions();
checkFunctionNamingConventions();
checkNamingConsistency();

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
