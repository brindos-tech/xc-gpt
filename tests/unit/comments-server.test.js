import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../server/app.js";
import { validateComment } from "../../server/validate.js";

const ORIGIN = "https://brindos-tech.github.io";
const TOKEN = "test-admin-token-0123456789";
let dir;
let app;
let base;
let clock = Date.parse("2026-11-01T12:00:00Z");

const start = async (opts = {}) => {
  app = createApp({ dataFile: path.join(dir, `c-${Math.random().toString(36).slice(2)}.jsonl`), adminToken: TOKEN, allowedOrigins: [ORIGIN], now: () => clock, ...opts });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
};
const stop = () => new Promise((r) => app.server.close(r));

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "xc-comments-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const post = (body, headers = {}) =>
  fetch(`${base}/comments`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "Fly-Client-IP": "1.2.3.4", ...headers }, body: JSON.stringify(body) });
const human = { elapsedMs: 20000 };
const admin = (p, opts = {}) => fetch(`${base}${p}`, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });

test("validation: subjects, rating, links, dates, content", () => {
  const ok = (b) => validateComment({ subject: "field:KOKC", ...b }, new Date("2026-11-01T12:00:00Z"));
  assert.equal(ok({ rating: 4 }).ok, true);
  assert.equal(ok({ rating: 6 }).ok, false);
  assert.equal(ok({}).ok, false, "needs something to say");
  assert.equal(ok({ notes: "see http://spam.example" }).ok, false);
  assert.equal(ok({ notes: "ok", visited: "2026-12-25" }).ok, false, "future date");
  assert.equal(ok({ notes: "ok", visited: "2026-02-30" }).ok, false, "not a real date");
  assert.equal(ok({ notes: "ok", visited: "2026-10-30" }).ok, true);
  assert.equal(ok({ notes: "ok", freeFood: "maybe" }).ok, false);
  assert.equal(validateComment({ subject: "bogus", notes: "x" }).ok, false);
  assert.equal(validateComment({ subject: "field:kokc", notes: "x" }).ok, false, "field codes are upper case");
  assert.equal(validateComment({ subject: "airspace:MOA:VANCE 1A MOA", notes: "x" }).ok, true);
  // field-only answers are dropped for airspace; text is trimmed and capped
  const a = validateComment({ subject: "airspace:IR:IR-002", rating: 3, freeFood: "yes", fees: "$5", notes: "  hot  " });
  assert.equal(a.value.freeFood, "");
  assert.equal(a.value.fees, "");
  assert.equal(a.value.notes, "hot");
  assert.equal(ok({ notes: "x".repeat(5000) }).value.notes.length, 1500);
  assert.equal(ok({ rating: 5 }).value.name, "Anonymous");
});

test("anyone can post and read comments; poster hashes stay private", async () => {
  await start();
  try {
    const res = await post({ subject: "field:KOKC", name: "Lt Test", rating: 5, freeFood: "yes", crewCar: "no", aircard: "yes", fees: "$20 ramp", planespotters: "great fence line", amenities: "coffee", visited: "2026-10-30", notes: "Great FBO.\nCookies.", ...human });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
    const { comment } = await res.json();
    assert.equal(comment.ipHash, undefined);

    const list = await (await fetch(`${base}/comments?subject=field:KOKC`, { headers: { Origin: ORIGIN } })).json();
    assert.equal(list.comments.length, 1);
    assert.equal(list.comments[0].name, "Lt Test");
    assert.equal(list.comments[0].ipHash, undefined);
    assert.equal((await (await fetch(`${base}/comments?subject=field:KPNC`)).json()).comments.length, 0);

    clock += 11 * 60 * 1000; // outside the 10 minute posting window
    await post({ subject: "field:KOKC", rating: 3, ...human });
    const sum = await (await fetch(`${base}/summary`)).json();
    assert.deepEqual(sum.summary["field:KOKC"], { n: 2, avg: 4 });
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    await stop();
  }
});

test("bots and bad requests: honeypot, fast fill, bad origin, bad body, size", async () => {
  await start();
  try {
    // honeypot and instant submits look like success but store nothing
    for (const extra of [{ website: "http://x" }, { elapsedMs: 300 }]) {
      const r = await post({ subject: "field:KOKC", rating: 5, elapsedMs: 20000, ...extra });
      assert.equal(r.status, 201);
    }
    assert.equal(app.store.size(), 0);
    assert.equal((await post({ subject: "field:KOKC", rating: 5, ...human }, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ subject: "nope", rating: 5, ...human })).status, 400);
    const bad = await fetch(`${base}/comments`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: "{not json" });
    assert.equal(bad.status, 400);
    const big = await fetch(`${base}/comments`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ notes: "x".repeat(20000) }) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    // only the allowed origin gets CORS headers, and preflight works
    const pre = await fetch(`${base}/comments`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
    const evil = await fetch(`${base}/comments?subject=field:KOKC`, { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  } finally {
    await stop();
  }
});

test("rate limit: 5 posts per 10 minutes per poster, others unaffected", async () => {
  await start();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await post({ subject: "field:KOKC", notes: `n${i}`, ...human })).status, 201);
    assert.equal((await post({ subject: "field:KOKC", notes: "n6", ...human })).status, 429);
    assert.equal((await post({ subject: "field:KOKC", notes: "other", ...human }, { "Fly-Client-IP": "9.9.9.9" })).status, 201);
  } finally {
    await stop();
  }
});

test("admin: needs the token, sees poster hashes, deletes one or a whole poster's comments", async () => {
  await start();
  try {
    await post({ subject: "field:KOKC", notes: "a", ...human });
    await post({ subject: "airspace:MOA:VANCE 1A MOA", notes: "b", ...human });
    await post({ subject: "field:KPNC", notes: "c", ...human }, { "Fly-Client-IP": "5.5.5.5" });

    assert.equal((await fetch(`${base}/admin/comments`)).status, 401);
    assert.equal((await fetch(`${base}/admin/comments`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    const all = (await (await admin("/admin/comments")).json()).comments;
    assert.equal(all.length, 3);
    assert.match(all[0].ipHash, /^[0-9a-f]{16}$/);

    const one = all.find((c) => c.notes === "c");
    assert.equal((await admin(`/admin/comments/${one.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await admin(`/admin/comments/${one.id}`, { method: "DELETE" })).status, 404);

    const mine = all.find((c) => c.notes === "a");
    const purged = await (await admin("/admin/purge", { method: "POST", body: JSON.stringify({ ipHash: mine.ipHash }) })).json();
    assert.equal(purged.deleted, 2);
    assert.equal(app.store.size(), 0);
    assert.equal((await admin("/admin/purge", { method: "POST", body: JSON.stringify({ ipHash: "nope" }) })).status, 400);
  } finally {
    await stop();
  }
});

test("admin page ships with a strict CSP; failed logins are throttled", async () => {
  await start();
  try {
    const page = await fetch(`${base}/admin`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(await page.text(), /Comments log/);
    assert.equal((await fetch(`${base}/admin/app.js`)).status, 200);
    let last;
    for (let i = 0; i < 12; i++) last = (await fetch(`${base}/admin/comments`, { headers: { Authorization: "Bearer nope" } })).status;
    assert.equal(last, 429);
  } finally {
    await stop();
  }
});

test("comments survive a restart, and deletes stay deleted", async () => {
  const file = path.join(dir, "persist.jsonl");
  await start({ dataFile: file });
  try {
    await post({ subject: "field:KOKC", notes: "keep", ...human });
    await post({ subject: "field:KOKC", notes: "drop", ...human });
    const id = app.store.bySubject("field:KOKC").find((c) => c.notes === "drop").id;
    await admin(`/admin/comments/${id}`, { method: "DELETE" });
  } finally {
    await stop();
  }
  await start({ dataFile: file });
  try {
    assert.deepEqual(app.store.bySubject("field:KOKC").map((c) => c.notes), ["keep"]);
    assert.equal(readFileSync(file, "utf-8").trim().split("\n").length, 1, "compacted on start");
  } finally {
    await stop();
  }
});
