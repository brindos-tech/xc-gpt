#!/usr/bin/env node
// Appends ?v=<version> to every local asset reference so a fresh deploy is
// never served out of a stale browser or CDN cache. GitHub Pages sends
// Cache-Control: max-age=600 on everything and offers no way to override it,
// so without this a just-merged change can take ~10 minutes to become
// visible — long enough to look like a broken deploy.
//
// Both halves matter. Stamping index.html's <link>/<script> refs alone is
// not enough: a query string on main.js does NOT propagate into its own
// `import "./store.js"` statements, because the browser drops the query when
// resolving a relative specifier against the importing module's URL. main.js
// is a thin orchestrator and effectively all the logic lives in the modules
// it pulls in, so if those aren't rewritten too the entire module graph stays
// cached even when the entry point doesn't.
//
// Runs against an assembled site directory at deploy time (see
// .github/workflows/deploy-pages.yml) — never against the working tree, so
// the committed source stays clean and diffable.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [siteDir, version] = process.argv.slice(2);
if (!siteDir || !version) {
  console.error("usage: stamp-version.js <site-dir> <version>");
  process.exit(1);
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : Promise.resolve([full]);
    })
  );
  return nested.flat();
}

// Only relative specifiers ending in .js — bare specifiers ("node:path") and
// absolute CDN URLs are left alone.
const MODULE_REF = /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?\.js)(["'])/g;
// Only assets/-rooted refs — the Leaflet CDN <link>/<script> tags must not be
// touched (a query string there would miss their cache and could 404).
const HTML_REF = /((?:href|src)=")(assets\/[^"]+?\.(?:css|js))(")/g;

// The data loader's version (see BUILD_VERSION in main.js) — so data/*.json
// URLs change per deploy too, rather than per page load.
const BUILD_PLACEHOLDER = "__BUILD_VERSION__";

let moduleRefs = 0;
let buildPlaceholders = 0;
const jsFiles = (await walk(path.join(siteDir, "assets", "js"))).filter((f) => f.endsWith(".js"));
for (const file of jsFiles) {
  const src = await readFile(file, "utf-8");
  const out = src
    .replace(MODULE_REF, (_m, pre, spec, post) => {
      moduleRefs++;
      return `${pre}${spec}?v=${version}${post}`;
    })
    .replaceAll(BUILD_PLACEHOLDER, () => {
      buildPlaceholders++;
      return version;
    });
  if (out !== src) await writeFile(file, out);
}

const indexPath = path.join(siteDir, "index.html");
const html = await readFile(indexPath, "utf-8");
let htmlRefs = 0;
const stamped = html.replace(HTML_REF, (_m, pre, ref, post) => {
  htmlRefs++;
  return `${pre}${ref}?v=${version}${post}`;
});
await writeFile(indexPath, stamped);

if (htmlRefs === 0 || moduleRefs === 0 || buildPlaceholders === 0) {
  console.error(
    `stamp-version: refusing a no-op stamp (index.html refs: ${htmlRefs}, module imports: ${moduleRefs}, ` +
      `${BUILD_PLACEHOLDER} placeholders: ${buildPlaceholders}).\n` +
      "Asset markup or import style probably changed — update the patterns in this script."
  );
  process.exit(1);
}

console.log(
  `Stamped v=${version} across ${jsFiles.length} modules: ${htmlRefs} refs in index.html, ${moduleRefs} module imports, ${buildPlaceholders} build placeholder(s).`
);
