#!/usr/bin/env node
// SeatGeek Platform API fetch — a second ticketing source alongside
// Ticketmaster, for venues and promoters that don't sell through it.
//
// Queried per curated place (lat/lon + radius) rather than per state:
// events only ever count if they land within 40 nm of a place anyway (see
// fetch-ticketmaster.js), so this spends the request budget only where it
// can matter. Overlap with Ticketmaster is expected and is reconciled by
// lib/dedupe.js at merge time.
//
// The free tier is rate-limited per hour, so requests are spaced evenly
// under REQUESTS_PER_HOUR and the whole run is capped at MAX_REQUESTS; a
// run that hits the cap keeps what it fetched rather than failing.
//
// Requires env var SEATGEEK_CLIENT_ID (repo secret, CI-only). Without it
// this exits 0 and merge.js runs without SeatGeek data.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fetchJsonWithRetry, createRateLimiter } from "./lib/http.js";
import { mapSeatGeekEvent } from "./lib/seatgeek-map.js";
import { greatCircleNm } from "../assets/js/geo.js";

const CURATED_DIR = path.resolve("data/curated");
const CACHE_DIR = path.resolve(".cache");
const API_BASE = "https://api.seatgeek.com/2";
const CLIENT_ID = process.env.SEATGEEK_CLIENT_ID;

const REQUESTS_PER_HOUR = Number(process.env.SEATGEEK_REQUESTS_PER_HOUR || 900);
const MAX_REQUESTS = Number(process.env.SEATGEEK_MAX_REQUESTS || 850);
const PER_PAGE = 250;
const MAX_PAGES_PER_PLACE = 4;
const DAYS_AHEAD = 90;
// 40 nm ~ 46 statute miles; SeatGeek's range is in miles
const RADIUS = "46mi";
const ATTACH_NM = 40;

const limiter = createRateLimiter(REQUESTS_PER_HOUR / 3600);
let requestCount = 0;

function nearestPlace(lat, lon, places) {
  let best = null;
  let bestDist = Infinity;
  for (const p of places) {
    const d = greatCircleNm({ lat, lon }, p);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return bestDist <= ATTACH_NM ? best : null;
}

function isoNoMs(d) {
  return d.toISOString().split(".")[0];
}

async function fetchAroundPlace(place, places, unmapped) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + DAYS_AHEAD);
  const out = [];

  for (let page = 1; page <= MAX_PAGES_PER_PLACE; page++) {
    if (requestCount >= MAX_REQUESTS) return { events: out, capped: true };
    await limiter();
    requestCount++;
    const url =
      `${API_BASE}/events?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&lat=${place.lat}&lon=${place.lon}&range=${RADIUS}` +
      `&datetime_utc.gte=${isoNoMs(now)}&datetime_utc.lte=${isoNoMs(end)}` +
      `&per_page=${PER_PAGE}&page=${page}`;
    let data;
    try {
      data = await fetchJsonWithRetry(url);
    } catch (err) {
      console.warn(`SeatGeek fetch failed near ${place.id} page ${page}: ${err.message.replace(CLIENT_ID, "***")}`);
      break;
    }
    const events = data.events || [];
    for (const ev of events) {
      const lat = Number(ev.venue?.location?.lat);
      const lon = Number(ev.venue?.location?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // attach to the nearest curated place, not the one queried — radii
      // around neighbouring places (Dallas / Fort Worth) overlap
      const nearest = nearestPlace(lat, lon, places);
      if (nearest) out.push(mapSeatGeekEvent(ev, nearest.id, unmapped));
    }
    const total = data.meta?.total ?? 0;
    if (events.length < PER_PAGE || page * PER_PAGE >= total) break;
  }
  return { events: out, capped: false };
}

async function main() {
  if (!CLIENT_ID) {
    console.error("SEATGEEK_CLIENT_ID not set — skipping fetch, leaving .cache/seatgeek.json untouched.");
    process.exit(0);
  }

  const places = JSON.parse(await readFile(path.join(CURATED_DIR, "places.json"), "utf-8"));
  const unmapped = new Map();
  const byId = new Map();
  let capped = false;

  for (const place of places) {
    const result = await fetchAroundPlace(place, places, unmapped);
    for (const ev of result.events) if (!byId.has(ev.id)) byId.set(ev.id, ev);
    if (result.capped) {
      capped = true;
      console.warn(`Hit the ${MAX_REQUESTS}-request cap at ${place.id}; keeping what was fetched.`);
      break;
    }
  }

  const all = Array.from(byId.values());
  const kept = all.filter((ev) => ev.category !== "misc" && ev.start);
  console.log(`SeatGeek: ${requestCount} requests, ${all.length} unique events near curated places, kept ${kept.length}.`);

  const byCategory = {};
  for (const ev of kept) byCategory[ev.category] = (byCategory[ev.category] || 0) + 1;
  console.log(`Kept by category: ${Object.entries(byCategory).map(([c, n]) => `${c} ${n}`).join(", ")}`);
  const byScale = {};
  for (const ev of kept) byScale[ev.scale] = (byScale[ev.scale] || 0) + 1;
  console.log(`Kept by scale: ${Object.entries(byScale).map(([c, n]) => `${c} ${n}`).join(", ")}`);
  if (unmapped.size) {
    const breakdown = Array.from(unmapped.entries()).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(", ");
    console.log(`Unmapped SeatGeek types (dropped): ${breakdown}`);
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, "seatgeek.json"), JSON.stringify(kept));
  console.log(`Wrote ${kept.length} SeatGeek events to .cache/seatgeek.json${capped ? " (partial: request cap reached)" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
