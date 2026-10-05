// Minimal static server for the smoke test — serves a directory the way
// GitHub Pages would (under a /xc-gpt/ subpath, so relative URLs and the
// service worker scope are exercised the same way as in production).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
};

export const BASE_PATH = "/xc-gpt/";

export function serve(root) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(BASE_PATH)) {
      res.writeHead(404).end();
      return;
    }
    let rel = decodeURIComponent(url.pathname.slice(BASE_PATH.length)) || "index.html";
    const file = path.join(root, rel);
    if (!file.startsWith(path.resolve(root))) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}${BASE_PATH}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
