import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
