import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectReferencedAssets } from "./lib/referenced-assets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.join(repoRoot, p);

const requiredFiles = [
  "manifest.json",
  "docs/MVP_SPEC.md",
  "src/background/worker.js",
  "src/content/vk.js",
  "src/options/options.html",
];

const missing = requiredFiles.filter((file) => !fs.existsSync(rel(file)));

// Every asset the manifest and its HTML pages reference must exist — a missing or
// mistyped path here is what renders as a broken image in the packaged extension.
const missingAssets = collectReferencedAssets(repoRoot)
  .filter((r) => !fs.existsSync(rel(r.path)));

if (missing.length > 0 || missingAssets.length > 0) {
  if (missing.length > 0) {
    console.error("Missing required files:");
    for (const file of missing) console.error(`- ${file}`);
  }
  if (missingAssets.length > 0) {
    console.error("Referenced assets missing on disk:");
    for (const r of missingAssets) console.error(`- ${r.path} (referenced by ${r.from})`);
  }
  process.exit(1);
}

console.log("CheburChat scaffold check passed.");
