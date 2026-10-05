#!/usr/bin/env node
// Weekly link-health sweep. Checks every event/place URL, flags likely-dead
// ones into meta.linkHealth (keyed by URL) so a stale link surfaces without
// ever blocking the build.
//
// Runs CONCURRENT_CHECKS requests in flight at once rather than one at a
// time — these URLs span hundreds of different third-party domains (event
// pages, venue sites), so a single shared "N requests/sec" limiter was
// throttling total throughput for no real politeness benefit: no one host
// was ever at risk of being hammered. At full event-dataset scale (thousands
// of URLs), the old fully-sequential version took 15+ minutes; this lands in
// single-digit seconds.
//
// Only 404/410 (or a hard network failure) count as "broken" — everything
// else is inconclusive. Verified directly against a live browser:
// ticketmaster.com (and the same pattern on AXS, Eventim, SeatGeek, Tixr —
// evidently standard across ticketing platforms) returns its own
// bot-detection block page to automated requests from datacenter IPs,
// regardless of whether the underlying event page is actually live. In this
// dataset that shows up as 401, 403, 530, and even a nonstandard 901 —
// different platforms, different edge configs, same underlying cause. That
// pattern held for any status code investigated that wasn't a clean 2xx or
// a genuine "gone" signal, and it's true of any CI runner — not something a
// smarter request can route around, and doing so would be evading anti-bot
// measures, which this project won't do. Hand-maintaining a list of "these
// specific codes mean blocked" is whack-a-mole (this file already grew one
// once). Flipping it — only trust the couple of statuses that reliably and
// specifically mean "this resource doesn't exist" — is the conservative,
// low-maintenance version: this is an advisory signal, and a missed dead
// link costs far less than a wave of false positives across thousands of
// live ones.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mapConcurrent } from "./lib/http.js";

const CURATED_DIR = path.resolve("data/curated");
const GENERATED_DIR = path.resolve("data/generated");
const CONCURRENT_CHECKS = 24;
const TIMEOUT_MS = 8000;
const DEFINITELY_BROKEN_STATUSES = new Set([404, 410]);

async function requestOnce(url, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, redirect: "follow", signal: controller.signal });
    return { status: res.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkUrl(url) {
  try {
    let result = await requestOnce(url, "HEAD");
    // 405 just means this server doesn't implement HEAD for this route —
    // not evidence the resource is missing. Retry with GET once before
    // drawing any conclusion.
    if (result.status === 405) {
      result = await requestOnce(url, "GET");
    }
    const broken = DEFINITELY_BROKEN_STATUSES.has(result.status);
    return { ok: !broken, status: result.status };
  } catch (err) {
    // A timeout is NOT evidence of a dead link. Ticketmaster tarpits
    // datacenter requests rather than refusing them — the 2026-10-04 sweep
    // flagged 2,199 of 2,202 URLs this way, every one a ticketmaster.com
    // page that loads fine in a browser. Same reasoning as the status-code
    // rule above: inconclusive, so not flagged.
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return { ok: true, status: null, inconclusive: "timeout" };
    }
    // a hard network failure (DNS, connection refused) is a stronger
    // signal than any HTTP-level response — bot-protection still completes
    // the handshake and returns *something*, so this is more likely a
    // genuinely dead domain.
    return { ok: false, status: null, error: err.message };
  }
}

async function main() {
  const [events, places] = await Promise.all([
    readFile(path.join(GENERATED_DIR, "events.json"), "utf-8").then(JSON.parse),
    readFile(path.join(CURATED_DIR, "places.json"), "utf-8").then(JSON.parse),
  ]);

  const urls = new Set();
  for (const e of events) if (e.url) urls.add(e.url);
  for (const p of places) if (p.links?.visit) urls.add(p.links.visit);
  const urlList = Array.from(urls);

  const results = await mapConcurrent(urlList, CONCURRENT_CHECKS, checkUrl);

  const linkHealth = {};
  let brokenCount = 0;
  let timedOut = 0;
  results.forEach((result, i) => {
    if (result.inconclusive) timedOut++;
    if (!result.ok) {
      linkHealth[urlList[i]] = { ...result, checkedAt: new Date().toISOString() };
      brokenCount++;
    }
  });

  const meta = JSON.parse(await readFile(path.join(GENERATED_DIR, "meta.json"), "utf-8").catch(() => "{}"));
  meta.linkHealth = linkHealth;
  await writeFile(path.join(GENERATED_DIR, "meta.json"), JSON.stringify(meta, null, 2));

  console.log(`Checked ${urlList.length} URLs, ${brokenCount} flagged as broken (404/410/network-failure only), ${timedOut} timed out (not flagged).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
