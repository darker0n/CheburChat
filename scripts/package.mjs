import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { collectReferencedAssets } from "./lib/referenced-assets.mjs";

// Builds a deterministic, store-ready zip: manifest.json at the archive root, all of
// src/, and the one third-party file the runtime loads. Everything in src/ ships by
// default, so a referenced asset can never be silently dropped (which is exactly how
// the onboarding logo went missing from the published build). A pre-flight pass refuses
// to build if a referenced file is missing or excluded.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.join(repoRoot, p);

// The only node_modules file the extension imports at runtime (src/background/crypto.js).
const VENDOR = "node_modules/openpgp/dist/openpgp.mjs";

// In the tree but referenced by nothing that ships: design sources and unused icon sizes.
// Excluding these only trims weight — it can never drop a needed file, since the post-build
// check below fails loudly if a referenced asset isn't in the archive.
const DENY = [
  "src/assets/branding/logo-full.png",
  "src/assets/branding/icon-design-sheet.png",
  "src/assets/icons/icon-512-master.png",
  "src/assets/icons/icon-64.png",
];
const denySet = new Set(DENY);

function fail(msg) {
  console.error(`\n✗ package: ${msg}\n`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(rel("manifest.json"), "utf8"));
const { version } = manifest;

// Clear any prior artifact for this version up front, so a failed run never leaves a
// stale zip behind that could be uploaded by mistake.
const distDir = rel("dist");
fs.mkdirSync(distDir, { recursive: true });
const outName = `cheburchat-${version}.zip`;
const outPath = path.join(distDir, outName);
fs.rmSync(outPath, { force: true });

// 1. Pre-flight: every referenced asset must exist and not be excluded.
const refs = collectReferencedAssets(repoRoot);
const problems = [];
for (const r of refs) {
  if (!fs.existsSync(rel(r.path))) {
    problems.push(`${r.path} — referenced by ${r.from}, missing on disk`);
  } else if (denySet.has(r.path)) {
    problems.push(`${r.path} — referenced by ${r.from}, but the package denylist would exclude it`);
  }
}
if (!fs.existsSync(rel(VENDOR))) {
  problems.push(`${VENDOR} — imported by src/background/crypto.js, missing (run npm install)`);
}
if (problems.length > 0) {
  fail("referenced files would be missing from the build:\n  - " + problems.join("\n  - "));
}

// 2. Build the zip from the repo root so manifest.json lands at the archive root.
const excludes = [...DENY, "*.DS_Store"];
execFileSync(
  "zip",
  ["-r", "-X", "-q", outPath, "manifest.json", "src", VENDOR, "-x", ...excludes],
  { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
);

// 3. Summary + the one thing the operator must not forget.
const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`✓ dist/${outName} — ${sizeKB} KB, manifest.json at archive root`);
console.log(`  bump manifest.json "version" (now ${version}) before re-uploading — the store rejects re-uploads at the same version`);
