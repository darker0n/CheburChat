import fs from "node:fs";

const requiredFiles = [
  "manifest.json",
  "docs/MVP_SPEC.md",
  "src/background/worker.js",
  "src/content/vk.js",
  "src/options/options.html"
];

const missing = requiredFiles.filter((file) => !fs.existsSync(file));
if (missing.length > 0) {
  console.error("Missing required files:");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

console.log("CheburChat scaffold check passed.");
