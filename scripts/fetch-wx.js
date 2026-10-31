#!/usr/bin/env node
// 8-day gridded weather for the planner overlays, from Open-Meteo (free, no
// key): pressure-level temperature / cloud cover / geopotential height plus
// surface visibility, precip, weather code and CAPE, at a 1° grid around the
// four departure bases and at every nav-list field. assets/js/planner/wx-model.js
// turns that into icing / ceiling / flight-category / precip / thunder.
//
// Output: data/generated/wx/{index.json, fields.json, YYYY-MM-DD.json}. The
// weather workflow publishes these on the `wx-data` branch (replaced each run)
// rather than committing them to main, so 3-hourly forecast files never
// accumulate in history.
//
//   node scripts/fetch-wx.js            full run
//   node scripts/fetch-wx.js --probe    one request, print the response shape

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fetchJsonWithRetry, sleep } from "./lib/http.js";
import { hourlyVariables, makeGrid, gridPoint, buildWxFiles } from "../assets/js/planner/wx-model.js";

const OUT_DIR = path.resolve("data/generated/wx");
const RANGE_NM = 650; // a little past the default 600 nm ring
const MODEL = "gfs_seamless";
const FORECAST_DAYS = 9; // UTC today .. +8 covers local today .. +7 across the US
const CHUNK = 100;
const BASE = "https://api.open-meteo.com/v1/forecast";

async function fetchChunk(points) {
  const url =
    `${BASE}?latitude=${points.map((p) => p.lat.toFixed(4)).join(",")}` +
    `&longitude=${points.map((p) => p.lon.toFixed(4)).join(",")}` +
    `&hourly=${hourlyVariables().join(",")}&models=${MODEL}&forecast_days=${FORECAST_DAYS}` +
    `&timezone=GMT&cell_selection=nearest`;
  const data = await fetchJsonWithRetry(url, {}, { retries: 5, baseDelayMs: 4000 });
  const arr = Array.isArray(data) ? data : [data];
  if (arr.length !== points.length) throw new Error(`Open-Meteo returned ${arr.length} locations for ${points.length} points`);
  return arr;
}

async function fetchAll(points) {
  const out = [];
  for (let i = 0; i < points.length; i += CHUNK) {
    out.push(...(await fetchChunk(points.slice(i, i + CHUNK))));
    process.stdout.write(`  ${Math.min(i + CHUNK, points.length)}/${points.length}\r`);
    await sleep(1500);
  }
  process.stdout.write("\n");
  return out;
}

async function main() {
  const config = JSON.parse(await readFile("data/curated/config.json", "utf-8"));
  const factsFile = JSON.parse(await readFile("data/generated/field-facts.json", "utf-8"));
  const grid = makeGrid(config.origins, RANGE_NM);
  const cellIdx = grid.cov.map((c, k) => (c ? k : -1)).filter((k) => k >= 0);
  const fieldCodes = Object.entries(factsFile.facts).filter(([, f]) => Number.isFinite(f.lat) && Number.isFinite(f.lon)).map(([code]) => code);
  console.log(`Grid ${grid.nlat}x${grid.nlon}, ${cellIdx.length} cells in range; ${fieldCodes.length} fields.`);

  if (process.argv.includes("--probe")) {
    const [loc] = await fetchChunk([{ lat: 36.3392, lon: -97.9166 }]);
    const h = loc.hourly;
    console.log("keys:", Object.keys(loc).join(","), "elevation:", loc.elevation, "units:", JSON.stringify(loc.hourly_units).slice(0, 400));
    console.log("hours:", h.time.length, h.time[0], "…", h.time.at(-1));
    for (const k of ["temperature_2m", "visibility", "precipitation", "cape", "weather_code", "temperature_850hPa", "cloud_cover_850hPa", "geopotential_height_850hPa"]) {
      console.log(k, JSON.stringify(h[k]?.slice(0, 6)), "nulls:", h[k]?.filter((v) => v == null).length);
    }
    return;
  }

  console.log("Fetching grid…");
  const gridResp = await fetchAll(cellIdx.map((k) => gridPoint(grid, k)));
  console.log("Fetching fields…");
  const fieldResp = await fetchAll(fieldCodes.map((c) => ({ lat: factsFile.facts[c].lat, lon: factsFile.facts[c].lon })));

  const times = gridResp[0].hourly.time;
  const gridLocs = new Map(cellIdx.map((k, n) => [k, gridResp[n]]));
  const fieldLocs = new Map(fieldCodes.map((c, n) => [c, fieldResp[n]]));
  const files = buildWxFiles({ grid, gridLocs, fieldLocs, times, model: MODEL, generatedAt: new Date().toISOString() });

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify(files.index));
  await writeFile(path.join(OUT_DIR, "fields.json"), JSON.stringify(files.fields));
  for (const [date, day] of Object.entries(files.days)) await writeFile(path.join(OUT_DIR, `${date}.json`), JSON.stringify(day));
  console.log(`Wrote ${files.index.steps.length} steps over ${files.index.dates.length} dates to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
