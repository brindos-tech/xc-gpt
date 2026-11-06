#!/usr/bin/env node
// Show-stopper NOTAMs (airport/runway closed, fuel unavailable) for every nav-list field and base, from the
// NOTAM Management Service API (NMS-API).
//
// How it works: get a bearer token (client id + secret, 30 minutes), ask for the "initial load" of all active
// domestic NOTAMs (the API answers with a short-lived signed link to a gzip of AIXM), stream-parse it and keep the
// closures that belong to our fields. If the initial load is not available to the account, fall back to asking
// for each field's NOTAMs one by one.
//
// Secrets (repository secrets; never printed): FAA_NMS_CLIENT_ID, FAA_NMS_CLIENT_SECRET.
// Optional (repository variables): FAA_NMS_BASE (default https://api-nms.aim.faa.gov) and FAA_NMS_AUTH_URL
// (default <base>/v1/auth/token). Use the staging host from the onboarding sheet while testing.
// Without the secrets the script says so and exits cleanly, writing nothing.
//
// Written to data/generated/wx/notams.json (published on the wx-data branch, read by the crew card).
//
//   node scripts/fetch-notams.js            full run
//   node scripts/fetch-notams.js --probe    check the connection and show what comes back; write nothing

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import path from "node:path";
import { createRateLimiter, mapConcurrent, redact } from "./lib/http.js";
import { notamsFromChunks, buildLocationIndex, fieldCodeFor } from "./lib/nms-aixm.js";
import { keepShowStoppers } from "../assets/js/planner/notams.js";

const OUT = path.resolve("data/generated/wx/notams.json");
const BASE = (process.env.FAA_NMS_BASE || "https://api-nms.aim.faa.gov").replace(/\/+$/, "");
const AUTH_URL = process.env.FAA_NMS_AUTH_URL || `${BASE}/v1/auth/token`;
const API = `${BASE}/nmsapi/v1`;
const UA = "xc-gpt-notam-fetch";

class FatalError extends Error {}

async function getToken(id, secret) {
  // Two standard ways to send a client id/secret: HTTP Basic (what the onboarding examples use), then in the form body.
  const attempts = [
    { headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` }, body: "grant_type=client_credentials" },
    { headers: {}, body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }).toString() },
  ];
  let refused = 0;
  for (const a of attempts) {
    const res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { ...a.headers, "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
      body: a.body,
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 401 || res.status === 403) {
      refused = res.status;
      continue;
    }
    if (!res.ok) throw new Error(`auth failed: HTTP ${res.status} at ${redact(AUTH_URL)}`);
    const body = await res.json();
    if (!body.access_token) throw new Error("auth answered without an access token");
    return { token: body.access_token, expiresIn: Number(body.expires_in) || 0, status: body.status };
  }
  throw new FatalError(`the NMS auth service refused the client id/secret (HTTP ${refused}) at ${redact(AUTH_URL)} (id is ${id.length} characters, secret ${secret.length})`);
}

const authHeaders = (token, extra = {}) => ({ authorization: `Bearer ${token}`, "user-agent": UA, ...extra });

/**
 * Follow a download link by hand: it may be relative to the NMS host (/nmsapi/v1/content/...) and may redirect on to a
 * signed storage link. The bearer token goes only to the NMS host; a signed link is fetched without it.
 */
async function download(url, token) {
  for (let hop = 0; hop < 5; hop++) {
    const target = new URL(url, `${BASE}/`);
    const headers = { "user-agent": UA };
    if (target.origin === new URL(BASE).origin) headers.authorization = `Bearer ${token}`;
    const res = await fetch(target, { headers, redirect: "manual", signal: AbortSignal.timeout(10 * 60000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), target).href;
      continue;
    }
    if (!res.ok) throw new Error(`initial load download: HTTP ${res.status}`);
    // the body may be JSON naming the real link, or the gzip itself
    if ((res.headers.get("content-type") || "").includes("json")) {
      const link = (await res.json())?.data?.url;
      if (!link) throw new Error("download answered with JSON but no link");
      url = link;
      continue;
    }
    return res;
  }
  throw new Error("initial load download: too many redirects");
}

/** Log how far a long download has got every few seconds, so a stall is visible in the run log. */
function watchProgress(label, stream, counter) {
  let bytes = 0;
  stream.on("data", (c) => (bytes += c.length));
  const timer = setInterval(() => console.log(`  ${label}: ${(bytes / 1e6).toFixed(1)} MB unpacked, ${counter()} NOTAMs`), 10000);
  timer.unref();
  return () => clearInterval(timer);
}

/** The initial-load file for all domestic NOTAMs as a stream of text chunks. */
async function initialLoad(token) {
  const res = await fetch(`${API}/notams/il/DOMESTIC`, { headers: authHeaders(token), redirect: "manual", signal: AbortSignal.timeout(60000) });
  let url;
  if (res.status >= 300 && res.status < 400) url = res.headers.get("location");
  else if (res.ok) url = (await res.json())?.data?.url;
  else throw Object.assign(new Error(`initial load: HTTP ${res.status}`), { status: res.status });
  if (!url) throw new Error("initial load answered without a download link");
  const file = await download(url, token);
  console.log(`  download started: ${file.headers.get("content-type")}, ${file.headers.get("content-length") || "unknown"} bytes`);
  return { stream: Readable.fromWeb(file.body).pipe(createGunzip()), bytes: Number(file.headers.get("content-length")) || 0 };
}

/** One field's NOTAMs (the fallback when the initial load is not allowed). */
async function notamsAt(location, token, limiter) {
  await limiter();
  const res = await fetch(`${API}/notams?location=${encodeURIComponent(location)}`, { headers: authHeaders(token, { nmsResponseFormat: "AIXM" }), signal: AbortSignal.timeout(60000) });
  if (res.status === 404) return []; // no NOTAMs there
  if (process.argv.includes("--probe")) console.log(`  per-field ${location}: HTTP ${res.status}, ${res.headers.get("content-type")}`);
  if (!res.ok) throw Object.assign(new Error(`NOTAMs for ${location}: HTTP ${res.status}`), { status: res.status });
  const out = [];
  for await (const n of notamsFromChunks([await res.text()])) out.push(n);
  return out;
}

async function fieldIndex() {
  const navinfo = JSON.parse(await readFile("data/curated/navinfo.json", "utf-8"));
  const config = JSON.parse(await readFile("data/curated/config.json", "utf-8"));
  const facts = JSON.parse(await readFile("data/generated/field-facts.json", "utf-8")).facts;
  const codes = [...new Set([...navinfo.fields.map((f) => f.code), ...config.origins.map((o) => o.icao)])];
  return { codes, byLocation: buildLocationIndex(codes, facts) };
}

const codeFor = fieldCodeFor;

async function probe(id, secret) {
  const auth = await getToken(id, secret);
  console.log(`auth OK at ${redact(AUTH_URL)} · token expires in ${auth.expiresIn}s · status ${auth.status}`);
  const ping = await fetch(`${API}/ping`, { headers: authHeaders(auth.token), signal: AbortSignal.timeout(30000) });
  console.log(`ping: HTTP ${ping.status}`);
  const { codes, byLocation } = await fieldIndex();
  try {
    const { stream, bytes } = await initialLoad(auth.token);
    let total = 0;
    let ours = 0;
    const kinds = {};
    const samples = [];
    const types = {};
    const stop = watchProgress("probe", stream, () => total);
    for await (const n of notamsFromChunks(stream)) {
      total++;
      types[n.type || "?"] = (types[n.type || "?"] || 0) + 1;
      const code = codeFor(n, byLocation);
      if (!code) continue;
      ours++;
      const [hit] = keepShowStoppers([n]);
      if (hit) {
        kinds[hit.kind] = (kinds[hit.kind] || 0) + 1;
        if (samples.length < 5) samples.push(`${code} ${hit.number} ${hit.kind}: ${hit.text.slice(0, 110)} [${hit.start} → ${hit.end}]`);
      }
    }
    stop();
    console.log(`initial load OK (${(bytes / 1e6).toFixed(1)} MB compressed): ${total} NOTAMs, types ${JSON.stringify(types)}; ${ours} are at our ${codes.length} fields`);
    console.log(`show-stoppers at our fields: ${JSON.stringify(kinds)}`);
    for (const s of samples) console.log(`  ${s}`);
  } catch (err) {
    console.log(`initial load failed (${err.message}); would fall back to per-field requests`);
    const one = await notamsAt("KOKC", auth.token, async () => {});
    console.log(`per-field request for KOKC: ${one.length} NOTAMs parsed`);
    for (const n of one.slice(0, 3)) console.log(`  ${n.number} ${n.location}: ${n.text.slice(0, 100)}`);
  }
}

async function main() {
  const id = (process.env.FAA_NMS_CLIENT_ID || "").trim();
  const secret = (process.env.FAA_NMS_CLIENT_SECRET || "").trim();
  if (!id || !secret) {
    console.log("FAA_NMS_CLIENT_ID / FAA_NMS_CLIENT_SECRET are not set: skipping NOTAMs.");
    return;
  }
  if (process.argv.includes("--probe")) return probe(id, secret);

  const { codes, byLocation } = await fieldIndex();
  const auth = await getToken(id, secret);
  const fields = {};
  const checked = new Set();
  let seen = 0;
  const keep = (list) => {
    for (const n of list) {
      const code = codeFor(n, byLocation);
      if (!code) continue;
      const [hit] = keepShowStoppers([n]);
      if (hit) (fields[code] ||= []).push({ id: hit.id, number: hit.number, text: hit.text, start: hit.start, end: hit.end, kind: hit.kind });
    }
  };
  try {
    const { stream } = await initialLoad(auth.token);
    const stop = watchProgress("initial load", stream, () => seen);
    try {
      for await (const n of notamsFromChunks(stream)) {
        seen++;
        keep([n]);
      }
    } finally {
      stop();
    }
    if (seen < 1000) throw new Error(`initial load had only ${seen} NOTAMs; not trusting it`);
    for (const c of codes) checked.add(c); // every active NOTAM was read: a field with none is clear
    console.log(`initial load: ${seen} NOTAMs read`);
  } catch (err) {
    if (err instanceof FatalError) throw err;
    console.log(`initial load not used (${err.message}); asking field by field`);
    const limiter = createRateLimiter(4);
    const failed = [];
    await mapConcurrent(codes, 3, async (code) => {
      try {
        keep(await notamsAt(code, auth.token, limiter));
        checked.add(code);
      } catch {
        failed.push(code);
      }
    });
    console.log(`${checked.size} fields checked, ${failed.length} failed`);
    if (checked.size < codes.length * 0.5) throw new Error("too many fields failed; keeping the previous file");
  }
  console.log(`${Object.keys(fields).length} fields have show-stopper NOTAMs`);
  await mkdir(path.dirname(OUT), { recursive: true });
  // "source" says what this is without calling it FAA data (the service terms forbid characterising redistributed data that way)
  await writeFile(OUT, JSON.stringify({ builtAt: new Date().toISOString(), source: "NOTAM distribution service", checked: [...checked].sort(), fields }));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
