import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, rmSync } from "node:fs";
import { fetchJsonWithRetry } from "../../scripts/lib/http.js";

async function withServer(handler, fn) {
  let hits = 0;
  const srv = createServer((req, res) => handler(++hits, req, res));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}`, () => hits);
  } finally {
    srv.close();
  }
}

test("a 4xx is not retried", async () => {
  await withServer(
    (n, req, res) => res.writeHead(403).end('{"message":"Invalid client credentials"}'),
    async (url, hits) => {
      await assert.rejects(fetchJsonWithRetry(url, {}, { baseDelayMs: 1 }), (err) => err.status === 403);
      assert.equal(hits(), 1);
    }
  );
});

test("a 5xx is retried until it succeeds", async () => {
  await withServer(
    (n, req, res) => (n < 3 ? res.writeHead(503).end() : res.writeHead(200).end('{"ok":true}')),
    async (url, hits) => {
      assert.deepEqual(await fetchJsonWithRetry(url, {}, { baseDelayMs: 1 }), { ok: true });
      assert.equal(hits(), 3);
    }
  );
});

test("SeatGeek fetch stops at the first rejected-key response and exits cleanly", async () => {
  await withServer(
    (n, req, res) => res.writeHead(403).end('{"message":"Invalid client credentials"}'),
    async (url, hits) => {
      const { stdout } = await promisify(execFile)("node", ["scripts/fetch-seatgeek.js"], {
        env: { ...process.env, SEATGEEK_CLIENT_ID: "bad", SEATGEEK_API_BASE: url, SEATGEEK_REQUESTS_PER_HOUR: "360000" },
      });
      assert.match(stdout, /::warning::SeatGeek rejected SEATGEEK_CLIENT_ID/);
      assert.equal(hits(), 1);
    }
  );
});

test("SeatGeek fetch pages past a silently capped page size, most popular first", async () => {
  const seen = [];
  await withServer(
    (n, req, res) => {
      const u = new URL(req.url, "http://x");
      seen.push(u.searchParams);
      const page = Number(u.searchParams.get("page"));
      const lat = Number(u.searchParams.get("lat"));
      const lon = Number(u.searchParams.get("lon"));
      // asks for 250, gets 100; 450 listed
      const events = Array.from({ length: 100 }, (_, i) => ({
        id: `${lat},${lon},${page},${i}`, title: `Show ${i}`, datetime_local: "2026-11-01T19:00:00", type: "concert",
        taxonomies: [{ id: 2000000, name: "concert" }], venue: { name: "V", location: { lat, lon } }, score: 0.5,
      }));
      res.writeHead(200).end(JSON.stringify({ events, meta: { total: 450, per_page: 250, page } }));
    },
    async (url) => {
      const { stdout } = await promisify(execFile)("node", ["scripts/fetch-seatgeek.js"], {
        env: { ...process.env, SEATGEEK_CLIENT_ID: "k", SEATGEEK_API_BASE: url, SEATGEEK_REQUESTS_PER_HOUR: "3600000" },
      });
      const places = JSON.parse(readFileSync("data/curated/places.json", "utf-8")).length;
      assert.equal(seen.length, places * 3, stdout);
      assert.deepEqual([...new Set(seen.map((p) => p.get("page")))].sort(), ["1", "2", "3"]);
      assert.ok(seen.every((p) => p.get("sort") === "score.desc"));
      assert.match(stdout, /page size 100/);
    }
  );
  rmSync(".cache/seatgeek.json", { force: true });
});
