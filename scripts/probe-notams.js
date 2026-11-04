#!/usr/bin/env node
// One-off probe: which public (no login) FAA NOTAM sources answer from GitHub
// Actions, and what their output looks like. Prints status + the start of
// each body; writes nothing.
//
//   node scripts/probe-notams.js

import { lookup } from "node:dns/promises";

const UA = "xc-gpt-notam-probe";

console.log("== DNS");
for (const host of ["notams.aim.faa.gov", "www.notams.faa.gov", "notams.faa.gov", "pilotweb.nas.faa.gov", "external-api.faa.gov", "api.faa.gov", "nms.aim.faa.gov", "aviationweather.gov", "tfr.faa.gov", "aeronav.faa.gov", "faa.gov"]) {
  try {
    const r = await lookup(host);
    console.log(`  ${host} -> ${r.address}`);
  } catch (err) {
    console.log(`  ${host} -> ${err.code}`);
  }
}

async function show(name, url, init = {}) {
  console.log(`\n===== ${name}`);
  try {
    const res = await fetch(url, { ...init, headers: { "user-agent": UA, accept: "*/*", ...(init.headers || {}) }, signal: AbortSignal.timeout(30000), redirect: "follow" });
    const body = await res.text();
    console.log(`HTTP ${res.status} ${res.url} · ${res.headers.get("content-type")} · ${body.length} bytes`);
    console.log(`has "RWY": ${/RWY/.test(body)} · has "notamList": ${body.includes("notamList")} · has "OKC": ${body.includes("OKC")}`);
    console.log(body.slice(0, 2500));
  } catch (err) {
    console.log(`FAILED: ${err.message} · ${err.cause?.code || ""}`);
  }
}

await show("NMS root", "https://nms.aim.faa.gov/");
await show("api.faa.gov root", "https://api.faa.gov/");
await show("external-api.faa.gov root", "https://external-api.faa.gov/");
for (const url of ["https://aviationweather.gov/api/data/openapi", "https://aviationweather.gov/data/api/openapi.yaml", "https://aviationweather.gov/api/data/notam?ids=KOKC&format=json"]) {
  console.log(`\n===== ${url}`);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
    const body = await res.text();
    console.log(`HTTP ${res.status} · ${res.headers.get("content-type")} · ${body.length} bytes · mentions notam: ${/notam/i.test(body)}`);
    console.log(body.slice(0, 600));
    const m = [...body.matchAll(/["']?\/[a-z/]*notam[a-z/]*["']?/gi)].slice(0, 5).map((x) => x[0]);
    if (m.length) console.log("notam paths:", m.join(" "));
  } catch (err) {
    console.log(`FAILED: ${err.message} ${err.cause?.code || ""}`);
  }
}
