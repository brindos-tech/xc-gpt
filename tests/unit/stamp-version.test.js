import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("stamps every local asset ref, module import and the data version", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "stamp-"));
  try {
    cpSync("index.html", path.join(dir, "index.html"));
    cpSync("assets", path.join(dir, "assets"), { recursive: true });
    execFileSync("node", ["scripts/stamp-version.js", dir, "abc12345"]);

    const html = readFileSync(path.join(dir, "index.html"), "utf-8");
    for (const [, ref] of html.matchAll(/(?:href|src)="(assets\/[^"]+\.(?:css|js)[^"]*)"/g)) {
      assert.match(ref, /\?v=abc12345$/, ref);
    }
    assert.match(html, /cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet\/1\.9\.4\/leaflet\.min\.js"/, "CDN refs untouched");

    const jsDir = path.join(dir, "assets", "js");
    const files = readdirSync(jsDir, { recursive: true }).filter((f) => f.endsWith(".js"));
    for (const f of files) {
      const src = readFileSync(path.join(jsDir, f), "utf-8");
      for (const [, spec] of src.matchAll(/from\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        assert.match(spec, /\.js\?v=abc12345$/, `${f}: ${spec}`);
      }
      assert.ok(!src.includes("__BUILD_VERSION__"), `${f} still has the placeholder`);
    }
    assert.match(readFileSync(path.join(jsDir, "main.js"), "utf-8"), /const BUILD_VERSION = "abc12345"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
