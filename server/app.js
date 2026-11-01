// The comments API. Plain node:http, no dependencies.
//
//   GET    /health
//   GET    /comments?subject=field:KOKC     public, newest first
//   GET    /summary                         public, { subject: { n, avg } }
//   POST   /comments                        public, rate limited
//   GET    /admin                           the log page (needs the token once)
//   GET    /admin/comments                  Bearer ADMIN_TOKEN: everything, with poster hashes
//   DELETE /admin/comments/:id              Bearer ADMIN_TOKEN
//   POST   /admin/purge  {ipHash}           Bearer ADMIN_TOKEN: delete all from one poster
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openStore } from "./store.js";
import { validateComment } from "./validate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 8 * 1024;
const MIN_FILL_MS = 2500; // a human takes longer than this to fill the form
const POST_LIMITS = [
  { windowMs: 10 * 60 * 1000, max: 5 },
  { windowMs: 24 * 3600 * 1000, max: 30 },
];
const GLOBAL_LIMIT = { windowMs: 3600 * 1000, max: 300 };
const AUTH_LIMIT = { windowMs: 60 * 1000, max: 10 };

const sha = (s) => createHash("sha256").update(s).digest();
const safeEqual = (a, b) => timingSafeEqual(sha(a), sha(b));

const ADMIN_FILES = {
  "/admin": ["admin.html", "text/html; charset=utf-8"],
  "/admin/app.js": ["admin.js", "text/javascript; charset=utf-8"],
  "/admin/app.css": ["admin.css", "text/css; charset=utf-8"],
};

/** Sliding-window counter per key. */
function limiter() {
  const hits = new Map();
  return {
    /** Records a hit; returns false when the window is already full. */
    take(key, { windowMs, max }, now) {
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= max) {
        hits.set(key, arr);
        return false;
      }
      arr.push(now);
      hits.set(key, arr);
      return true;
    },
    sweep(now, maxAge = 24 * 3600 * 1000) {
      for (const [k, arr] of hits) if (!arr.some((t) => now - t < maxAge)) hits.delete(k);
    },
  };
}

export function createApp({ dataFile, adminToken, allowedOrigins = [], ipSalt, now = () => Date.now() }) {
  const store = openStore(dataFile);
  const salt = ipSalt || adminToken || randomBytes(16).toString("hex");
  const posts = limiter();
  const global = limiter();
  const auth = limiter();
  const allowed = new Set(allowedOrigins);
  const adminAssets = Object.fromEntries(Object.entries(ADMIN_FILES).map(([url, [file, type]]) => [url, { body: readFileSync(path.join(HERE, file)), type }]));

  const ipHash = (req) => createHash("sha256").update(`${salt}|${req.headers["fly-client-ip"] || req.socket.remoteAddress || ""}`).digest("hex").slice(0, 16);

  function corsHeaders(req) {
    const origin = req.headers.origin;
    const h = { Vary: "Origin" };
    if (origin && allowed.has(origin)) {
      h["Access-Control-Allow-Origin"] = origin;
      h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      h["Access-Control-Allow-Headers"] = "Content-Type";
      h["Access-Control-Max-Age"] = "600";
    }
    return h;
  }

  function send(req, res, status, body, extra = {}) {
    const isString = typeof body === "string" || Buffer.isBuffer(body);
    res.writeHead(status, {
      "Content-Type": isString ? extra["Content-Type"] || "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(req),
      ...extra,
    });
    res.end(isString ? body : JSON.stringify(body));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error("Too large"), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "null"));
        } catch {
          reject(Object.assign(new Error("Bad JSON"), { status: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  const publicView = ({ ipHash: _ip, ...c }) => c;

  function isAdmin(req, res) {
    const t = now();
    const ip = ipHash(req);
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!adminToken || !m || !safeEqual(m[1], adminToken)) {
      if (!auth.take(`auth:${ip}`, AUTH_LIMIT, t)) send(req, res, 429, { error: "Too many attempts." });
      else send(req, res, 401, { error: "Unauthorized." });
      return false;
    }
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const t = now();
    posts.sweep(t);

    if (req.method === "OPTIONS") return send(req, res, 204, "");
    if (url.pathname === "/health") return send(req, res, 200, { ok: true, comments: store.size() });

    // ---- admin page (static) and API ----
    const asset = adminAssets[url.pathname];
    if (asset && req.method === "GET") {
      return send(req, res, 200, asset.body, {
        "Content-Type": asset.type,
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
      });
    }
    if (url.pathname === "/admin/comments" && req.method === "GET") {
      if (!isAdmin(req, res)) return;
      return send(req, res, 200, { comments: store.all(Math.min(1000, Number(url.searchParams.get("limit")) || 300)) });
    }
    const del = /^\/admin\/comments\/([\w-]+)$/.exec(url.pathname);
    if (del && req.method === "DELETE") {
      if (!isAdmin(req, res)) return;
      return store.remove(del[1]) ? send(req, res, 200, { deleted: 1 }) : send(req, res, 404, { error: "No such comment." });
    }
    if (url.pathname === "/admin/purge" && req.method === "POST") {
      if (!isAdmin(req, res)) return;
      const body = await readJson(req);
      if (!/^[0-9a-f]{16}$/.test(body?.ipHash || "")) return send(req, res, 400, { error: "ipHash required." });
      return send(req, res, 200, { deleted: store.removeWhere((c) => c.ipHash === body.ipHash) });
    }

    // ---- public ----
    if (url.pathname === "/comments" && req.method === "GET") {
      const subject = url.searchParams.get("subject") || "";
      if (!subject) return send(req, res, 400, { error: "subject required." });
      return send(req, res, 200, { comments: store.bySubject(subject).map(publicView) });
    }
    if (url.pathname === "/summary" && req.method === "GET") return send(req, res, 200, { summary: store.summary() });

    if (url.pathname === "/comments" && req.method === "POST") {
      const origin = req.headers.origin;
      if (origin && !allowed.has(origin)) return send(req, res, 403, { error: "Origin not allowed." });
      const ip = ipHash(req);
      if (!global.take("all", GLOBAL_LIMIT, t)) return send(req, res, 429, { error: "Busy — try again later." });
      for (const lim of POST_LIMITS) {
        if (!posts.take(`${ip}:${lim.windowMs}`, lim, t)) return send(req, res, 429, { error: "You're posting too fast. Try again later." });
      }
      const body = await readJson(req);
      // bots: filled the hidden field, or submitted faster than a person can type.
      // Look like a success so they don't adapt.
      if (body && (body.website || (Number(body.elapsedMs) || 0) < MIN_FILL_MS)) return send(req, res, 201, { comment: { id: "ok" } });
      const v = validateComment(body, new Date(t));
      if (!v.ok) return send(req, res, 400, { error: v.error });
      const comment = { id: `${t.toString(36)}${randomBytes(4).toString("hex")}`, ...v.value, createdAt: new Date(t).toISOString(), ipHash: ip };
      store.add(comment);
      return send(req, res, 201, { comment: publicView(comment) });
    }

    return send(req, res, 404, { error: "Not found." });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      send(req, res, err.status || 500, { error: err.status ? err.message : "Server error." });
      if (!err.status) console.error(err);
    });
  });
  return { server, store };
}
