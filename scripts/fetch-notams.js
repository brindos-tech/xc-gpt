#!/usr/bin/env node
// Show-stopper NOTAMs (airport/runway closed, fuel unavailable) for every nav-list field and base, from the
// NOTAM Management Service API (NMS-API).
//
// How it works: get a bearer token (client id + secret, 30 minutes), ask for the "initial load" of all active
// domestic NOTAMs (the API answers with a short-lived signed link to a gzip of AIXM), stream-parse it and keep the
// closures that belong to our fields. If the initial load is not available to the account, fall back to asking
// for each field's NOTAMs one by one.
//
// Service limits (from the onboarding email): ONE bulk pull (initial load) per 24 hours at most, and one data pull
// per 3 minutes. So: this script does at most one bulk pull a day (it refuses when the last published file is under
// 23 hours old, unless run with --force) and never asks field by field in a loop.
//
// Secrets (repository secrets; never printed): FAA_NMS_CLIENT_ID, FAA_NMS_CLIENT_SECRET.
// Optional (repository variables): FAA_NMS_BASE (default https://api-nms.aim.faa.gov) and FAA_NMS_AUTH_URL
// (default <base>/v1/auth/token). Use the staging host from the onboarding sheet while testing.
// Without the secrets the script says so and exits cleanly, writing nothing.
//
// Written to data/generated/wx/notams.json (published on the wx-data branch, read by the crew card).
//
//   node scripts/fetch-notams.js            full run
//   node scripts/fetch-notams.js --probe    check the connection with ONE single-field request (no bulk pull); write nothing
//   node scripts/fetch-notams.js --force    bulk pull even if the last one was under 23 hours ago (counts against the daily limit)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import path from "node:path";
import { createRateLimiter, mapConcurrent, redact } from "./lib/http.js";
import { notamsFromChunks, notamsFromAnswer, buildLocationIndex, fieldCodeFor } from "./lib/nms-aixm.js";
import { keepShowStoppers } from "../assets/js/planner/notams.js";

const OUT = path.resolve("data/generated/wx/notams.json");
const PREVIOUS = path.resolve(process.env.NOTAMS_PREVIOUS || "data/generated/wx/notams.previous.json"); // the last published file, fetched by the workflow
const MIN_HOURS_BETWEEN_BULK = 23;
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
    const res = await fetch(target, { headers, redirect: "manual", signal: AbortSignal.timeout(30 * 60000) });
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
  const text = await res.text();
  if (process.argv.includes("--probe")) console.log(`  per-field ${location} body (${text.length} chars): ${JSON.stringify(text.slice(0, 900))}`);
  return notamsFromAnswer(text);
}

async function fieldIndex() {
  const navinfo = JSON.parse(await readFile("data/curated/navinfo.json", "utf-8"));
  const config = JSON.parse(await readFile("data/curated/config.json", "utf-8"));
  const facts = JSON.parse(await readFile("data/generated/field-facts.json", "utf-8")).facts;
  const codes = [...new Set([...navinfo.fields.map((f) => f.code), ...config.origins.map((o) => o.icao)])];
  return { codes, byLocation: buildLocationIndex(codes, facts) };
}

const codeFor = fieldCodeFor;

/** Say what the start of the initial load looks like (public NOTAM text, no secrets) when nothing could be parsed. */
function describeHead(head, parsed) {
  if (parsed > 0 || !head) return;
  const count = (re) => (head.match(re) || []).length;
  console.log(`  first 3 MB: ${head.length} chars; '</aixm:member>' x${count(/<\/aixm:member>/g)}, '<event:NOTAM' x${count(/<event:NOTAM[\s>]/g)}, 'textNOTAM' x${count(/textNOTAM/g)}, '<hasMember' x${count(/<hasMember/g)}`);
  const root = head.search(/<[A-Za-z0-9:]*FeatureCollection[^>]*>/);
  const after = root >= 0 ? head.indexOf(">", head.indexOf("numberReturned", root)) + 1 || root : 0;
  console.log(`  start of file: ${JSON.stringify(head.slice(0, 160))}`);
  console.log(`  after the root tag: ${JSON.stringify(head.slice(after, after + 1800))}`);
  const textNotam = head.search(/<event:textNOTAM/);
  if (textNotam >= 0) console.log(`  around the first NOTAM: ${JSON.stringify(head.slice(Math.max(0, textNotam - 200), textNotam + 1500))}`);
}

async function probe(id, secret) {
  const auth = await getToken(id, secret);
  console.log(`auth OK at ${redact(AUTH_URL)} · token expires in ${auth.expiresIn}s · status ${auth.status}`);
  const ping = await fetch(`${API}/ping`, { headers: authHeaders(auth.token), signal: AbortSignal.timeout(30000) });
  console.log(`ping: HTTP ${ping.status}`);
  const { codes, byLocation } = await fieldIndex();
  // one single-field request stands in for the bulk load, which the service allows only once a day
  const here = await notamsAt("KOKC", auth.token, async () => {});
  const stoppers = keepShowStoppers(here);
  console.log(`single-field request for KOKC: ${here.length} NOTAMs parsed, ${stoppers.length} show-stoppers; ${codes.length} fields in our list (${byLocation.size} location ids)`);
  for (const n of here.slice(0, 3)) console.log(`  ${n.number} ${n.location}: ${n.text.slice(0, 100)}`);
  for (const n of stoppers.slice(0, 3)) console.log(`  show-stopper ${n.number} ${n.kind}: ${n.text.slice(0, 100)}`);
  console.log("bulk load not tried by the probe (limit: one per 24 hours).");
}

async function main() {
  const id = (process.env.FAA_NMS_CLIENT_ID || "").trim();
  const secret = (process.env.FAA_NMS_CLIENT_SECRET || "").trim();
  if (!id || !secret) {
    console.log("FAA_NMS_CLIENT_ID / FAA_NMS_CLIENT_SECRET are not set: skipping NOTAMs.");
    return;
  }
  if (process.argv.includes("--probe")) return probe(id, secret);

  if (!process.argv.includes("--force")) {
    const last = await readFile(PREVIOUS, "utf-8").then((t) => JSON.parse(t), () => null);
    const ageH = last?.builtAt ? (Date.now() - Date.parse(last.builtAt)) / 3600000 : Infinity;
    if (ageH < MIN_HOURS_BETWEEN_BULK) {
      console.log(`last NOTAM load was ${ageH.toFixed(1)} hours ago; the service allows one bulk pull per 24 hours, so not asking again (use --force to override).`);
      return;
    }
  }
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
      if (!hit) continue;
      // the service can list one closure under two numbers: keep one per field, text and period
      if (fields[code]?.some((o) => o.text === hit.text && o.start === hit.start && o.end === hit.end)) continue;
      (fields[code] ||= []).push({ id: hit.id, number: hit.number, text: hit.text, start: hit.start, end: hit.end, kind: hit.kind });
    }
  };
  // one bulk pull; if it fails the run fails and the previous file stays in place (no field-by-field loop: rate limits)
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
  if (seen < 1000) throw new Error(`initial load had only ${seen} NOTAMs; not trusting it, keeping the previous file`);
  for (const c of codes) checked.add(c); // every active NOTAM was read: a field with none is clear
  console.log(`initial load: ${seen} NOTAMs read`);
  console.log(`${Object.keys(fields).length} fields have show-stopper NOTAMs`);
  await mkdir(path.dirname(OUT), { recursive: true });
  // "source" says what this is without calling it FAA data (the service terms forbid characterising redistributed data that way)
  await writeFile(OUT, JSON.stringify({ builtAt: new Date().toISOString(), source: "NOTAM distribution service", checked: [...checked].sort(), fields }));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
