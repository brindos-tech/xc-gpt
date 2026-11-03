#!/usr/bin/env node
// Show-stopper NOTAMs (airport/runway closed, fuel unavailable) for every
// nav-list field and base, from the FAA NOTAM API (external-api.faa.gov).
// Needs the FAA API credentials as FAA_NOTAM_CLIENT_ID / FAA_NOTAM_CLIENT_SECRET;
// without them the script says so and exits cleanly, writing nothing.
// Written to data/generated/wx/notams.json (published on the wx-data branch,
// read by the crew card).
//
//   node scripts/fetch-notams.js            full run
//   node scripts/fetch-notams.js --probe    print the response shape for KOKC, write nothing

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createRateLimiter, mapConcurrent, sleep } from "./lib/http.js";
import { extractNotam, keepShowStoppers } from "../assets/js/planner/notams.js";

const OUT = path.resolve("data/generated/wx/notams.json");
const API = "https://external-api.faa.gov/notamapi/v1/notams";
const PAGE_SIZE = 1000;

async function getPage(code, page, headers) {
  const url = `${API}?icaoLocation=${encodeURIComponent(code)}&pageSize=${PAGE_SIZE}&pageNum=${page}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`FAA NOTAM API refused the credentials (HTTP ${res.status})`), { fatal: true });
    if (res.ok) return res.json();
    if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} for ${code}`);
    await sleep(1500 * (attempt + 1));
  }
  throw new Error(`gave up on ${code}`);
}

async function notamsFor(code, headers, limiter) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    await limiter();
    const body = await getPage(code, page, headers);
    for (const item of body.items || []) all.push(extractNotam(item));
    if (page >= (body.totalPages || 1)) break;
  }
  return all.filter(Boolean);
}

async function main() {
  const id = process.env.FAA_NOTAM_CLIENT_ID;
  const secret = process.env.FAA_NOTAM_CLIENT_SECRET;
  if (!id || !secret) {
    console.log("FAA_NOTAM_CLIENT_ID / FAA_NOTAM_CLIENT_SECRET are not set: skipping NOTAMs.");
    return;
  }
  const headers = { client_id: id, client_secret: secret, accept: "application/json" };
  if (process.argv.includes("--probe")) {
    const body = await getPage("KOKC", 1, headers);
    console.log(`keys: ${Object.keys(body).join(", ")} · totalCount ${body.totalCount} · items ${body.items?.length}`);
    console.log(JSON.stringify(body.items?.[0], null, 1)?.slice(0, 2500));
    const parsed = (body.items || []).map(extractNotam).filter(Boolean);
    console.log(`parsed ${parsed.length}/${body.items?.length}; show-stoppers: ${keepShowStoppers(parsed).length}`);
    return;
  }
  const navinfo = JSON.parse(await readFile("data/curated/navinfo.json", "utf-8"));
  const config = JSON.parse(await readFile("data/curated/config.json", "utf-8"));
  const codes = [...new Set([...navinfo.fields.map((f) => f.code), ...config.origins.map((o) => o.icao)])].filter((c) => /^[A-Z0-9]{3,4}$/.test(c));
  const limiter = createRateLimiter(4);
  const fields = {};
  const checked = [];
  const failed = [];
  await mapConcurrent(codes, 3, async (code) => {
    try {
      const list = keepShowStoppers(await notamsFor(code, headers, limiter));
      checked.push(code);
      if (list.length) fields[code] = list.map(({ id, number, text, start, end, kind }) => ({ id, number, text, start, end, kind }));
    } catch (err) {
      if (err.fatal) throw err;
      failed.push(code);
    }
  });
  console.log(`${checked.length} fields checked, ${Object.keys(fields).length} with show-stoppers, ${failed.length} failed${failed.length ? ` (${failed.slice(0, 10).join(", ")}…)` : ""}`);
  if (checked.length < codes.length * 0.5) throw new Error("too many fields failed; keeping the previous file");
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ builtAt: new Date().toISOString(), source: "FAA NOTAM API", checked: checked.sort(), fields }));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
