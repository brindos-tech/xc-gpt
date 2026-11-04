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

await show("NOTAM Search home", "https://notams.aim.faa.gov/notamSearch/");
await show("NOTAM Search, POST by location", "https://notams.aim.faa.gov/notamSearch/search", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-requested-with": "XMLHttpRequest" },
  body: new URLSearchParams({ searchType: "0", designatorsForLocation: "KOKC", formatType: "DOMESTIC", notamType: "", operatorType: "", operatorCondition: "" }).toString(),
});
await show("DINS (old host)", "https://www.notams.faa.gov/dinsQueryWeb/queryRetrievalMapAction.do?reportType=Raw&retrieveLocId=KOKC&actionType=notamRetrievalByICAOs&submit=View+NOTAMs");
