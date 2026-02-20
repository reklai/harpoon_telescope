// Build script: compiles TypeScript sources via esbuild, copies static assets to dist/
import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");
const watching = process.argv.includes("--watch");

// Determine target browser: firefox (MV2) or chrome (MV3)
const targetIdx = process.argv.indexOf("--target");
const target = targetIdx !== -1 ? process.argv[targetIdx + 1] : "firefox";
if (!["firefox", "chrome"].includes(target)) {
  console.error(`[build] Unknown target "${target}". Use "firefox" or "chrome".`);
  process.exit(1);
}

const manifestFile = target === "chrome" ? "manifest_v3.json" : "manifest_v2.json";
console.log(`[build] Target: ${target} (${manifestFile})`);

// Shared esbuild options — IIFE bundles for extension contexts
const shared = {
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: false,
  sourcemap: false,
};

// Each entry point produces one JS file in dist/ (paths relative to project root)
const entryPoints = [
  { in: resolve(root, "src/entryPoints/background/background.ts"), out: "background" },
  { in: resolve(root, "src/entryPoints/contentScript/contentScript.ts"), out: "contentScript" },
  { in: resolve(root, "src/entryPoints/toolbarPopup/toolbarPopup.ts"), out: "toolbarPopup/toolbarPopup" },
  { in: resolve(root, "src/entryPoints/optionsPage/optionsPage.ts"), out: "optionsPage/optionsPage" },
];

// Static assets to copy into dist/ (manifests live in build/, sources in src/)
const staticFiles = [
  [resolve(__dirname, manifestFile), "manifest.json"],
  [resolve(root, "src/entryPoints/toolbarPopup/toolbarPopup.html"), "toolbarPopup/toolbarPopup.html"],
  [resolve(root, "src/entryPoints/toolbarPopup/toolbarPopup.css"), "toolbarPopup/toolbarPopup.css"],
  [resolve(root, "src/entryPoints/optionsPage/optionsPage.html"), "optionsPage/optionsPage.html"],
  [resolve(root, "src/entryPoints/optionsPage/optionsPage.css"), "optionsPage/optionsPage.css"],
  [resolve(root, "src/icons/icon-48.png"), "icons/icon-48.png"],
  [resolve(root, "src/icons/icon-96.png"), "icons/icon-96.png"],
  [resolve(root, "src/icons/icon-128.png"), "icons/icon-128.png"],
];

function copyStatic() {
  for (const [from, to] of staticFiles) {
    const dest = resolve(dist, to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(from, dest);
  }
  console.log("[build] Static assets copied");
}

async function main() {
  mkdirSync(dist, { recursive: true });
  copyStatic();

  const buildOptions = {
    ...shared,
    entryPoints: entryPoints.map((e) => ({
      in: e.in,
      out: e.out,
    })),
    outdir: dist,
    loader: { ".css": "text" },
  };

  if (watching) {
    const ctx = await context(buildOptions);
    await ctx.watch();
    console.log("[build] Watching for changes...");
  } else {
    await build(buildOptions);
    console.log("[build] Done");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
