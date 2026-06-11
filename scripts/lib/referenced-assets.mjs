import fs from "node:fs";
import path from "node:path";

// Single source of truth for "what files the shipped extension actually references".
// Both the scaffold check and the packager use this so a referenced asset can't be
// silently missing on disk or dropped from the store zip (the onboarding logo bug).
//
// Returns deduplicated repo-root-relative paths (posix slashes), each tagged with the
// file that referenced it for readable error messages.

const toPosix = (p) => p.split(path.sep).join("/");

function manifestRefs(repoRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
  const out = [];
  const add = (p) => { if (p) out.push({ path: p, from: "manifest.json" }); };

  for (const p of Object.values(manifest.icons ?? {})) add(p);
  for (const p of Object.values(manifest.action?.default_icon ?? {})) add(p);
  add(manifest.action?.default_popup);
  add(manifest.background?.service_worker);
  add(manifest.options_ui?.page);
  for (const cs of manifest.content_scripts ?? []) {
    for (const p of cs.js ?? []) add(p);
    for (const p of cs.css ?? []) add(p);
  }
  return out;
}

function htmlRefs(repoRoot, htmlRel) {
  const html = fs.readFileSync(path.join(repoRoot, htmlRel), "utf8");
  const dir = path.dirname(htmlRel);
  const out = [];
  const re = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let m = re.exec(html);
  while (m !== null) {
    const ref = m[1];
    if (!/^(?:data:|https?:|#|mailto:)/.test(ref)) {
      out.push({ path: toPosix(path.join(dir, ref)), from: htmlRel });
    }
    m = re.exec(html);
  }
  return out;
}

export function collectReferencedAssets(repoRoot) {
  const refs = manifestRefs(repoRoot);
  // Follow the manifest's own HTML pages and collect what they pull in.
  for (const r of [...refs]) {
    if (r.path.endsWith(".html") && fs.existsSync(path.join(repoRoot, r.path))) {
      refs.push(...htmlRefs(repoRoot, r.path));
    }
  }
  const seen = new Map();
  for (const r of refs) {
    if (!seen.has(r.path)) seen.set(r.path, r);
  }
  return [...seen.values()];
}
