// Build script: compiles TypeScript sources via esbuild, copies static assets to dist/
import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, "dist");
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

// Each entry point produces one JS file in dist/
const entryPoints = [
  { in: "src/background.ts", out: "background" },
  { in: "src/content-script.ts", out: "content-script" },
  { in: "src/popup/popup.ts", out: "popup/popup" },
  { in: "src/options/options.ts", out: "options/options" },
];

// Static assets to copy into dist/ (preserving directory structure)
const staticFiles = [
  [`src/${manifestFile}`, "manifest.json"],
  ["src/popup/popup.html", "popup/popup.html"],
  ["src/popup/popup.css", "popup/popup.css"],
  ["src/options/options.html", "options/options.html"],
  ["src/options/options.css", "options/options.css"],
  ["src/icons/icon-48.png", "icons/icon-48.png"],
  ["src/icons/icon-96.png", "icons/icon-96.png"],
  ["src/icons/icon-128.png", "icons/icon-128.png"],
];

function copyStatic() {
  for (const [from, to] of staticFiles) {
    const dest = resolve(dist, to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(resolve(__dirname, from), dest);
  }
  console.log("[build] Static assets copied");
}

async function main() {
  mkdirSync(dist, { recursive: true });
  copyStatic();

  const buildOptions = {
    ...shared,
    entryPoints: entryPoints.map((e) => ({
      in: resolve(__dirname, e.in),
      out: e.out,
    })),
    outdir: dist,
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
