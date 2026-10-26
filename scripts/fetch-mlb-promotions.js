#!/usr/bin/env node
// MLB + Minor League promotions -> PR overlays. Teams publish theme nights
// ("Military Appreciation Night", "Salute to Armed Forces") as game
// promotions in the public MLB Stats API, which also covers every MiLB
// level — the Tulsa Drillers, OKC Comets, Wichita Wind Surge, Frisco
// RoughRiders and so on — on the same endpoint. No key needed.
//
// Output is a list of overlays for merge.js (same shape as
// data/curated/pr-events.json): tag the matching Ticketmaster/SeatGeek
// listing of that game if there is one, otherwise add the game itself.
//
// The promotions hydration is undocumented, so this reads defensively and
// never fails the build: on any error it writes nothing and exits 0.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fetchJsonWithRetry } from "./lib/http.js";
import { greatCircleNm } from "../assets/js/geo.js";

const CURATED_DIR = path.resolve("data/curated");
const CACHE_DIR = path.resolve(".cache");
const API = process.env.MLB_STATSAPI_BASE || "https://statsapi.mlb.com/api/v1";
// MLB, AAA, AA, High-A, Single-A
const SPORT_IDS = [1, 11, 12, 13, 14];
const ATTACH_NM = 40;

export const MILITARY_PROMO =
  /military|veteran|armed forces|salute to (service|the troops|our heroes)|\bheroes?\b|air force|\bnavy\b|\barmy\b|marine corps|coast guard|national guard|memorial day|independence day|4th of july|fourth of july|patriot/i;

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

/** One schedule response -> overlays for games with a military promotion. */
export function overlaysFromSchedule(data, places, today) {
  const out = [];
  for (const day of data?.dates || []) {
    for (const g of day.games || []) {
      const date = g.officialDate || day.date;
      if (!date || date < today) continue;
      const promos = (g.promotions || []).filter((p) => MILITARY_PROMO.test(`${p.name || ""} ${p.description || ""}`));
      if (!promos.length) continue;
      const coords = g.venue?.location?.defaultCoordinates;
      const lat = Number(coords?.latitude);
      const lon = Number(coords?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const place = nearestPlace(lat, lon, places);
      if (!place) continue;
      const home = g.teams?.home?.team?.name || "Home";
      const away = g.teams?.away?.team?.name || "Visitors";
      // match on the club nickname ("Drillers"), which is what ticket
      // listings carry, rather than the full "Tulsa Drillers"
      const nickname = home.split(" ").pop();
      out.push({
        id: `mlb-${g.gamePk}`,
        placeId: place.id,
        start: date,
        match: nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        title: `${away} at ${home} — ${promos[0].name}`,
        category: "sports",
        scale: g.teams?.home?.team?.sport?.id === 1 ? "major" : "notable",
        url: `https://www.mlb.com/gameday/${g.gamePk}`,
        reason: `Team promotion: ${promos.map((p) => p.name).join(", ")}${g.venue?.name ? ` at ${g.venue.name}` : ""}`,
      });
    }
  }
  return out;
}

async function main() {
  const places = JSON.parse(await readFile(path.join(CURATED_DIR, "places.json"), "utf-8"));
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  // the rest of this season plus next: schedules (and promotions) for the
  // coming year are published over the winter
  const start = today;
  const end = `${now.getFullYear() + 1}-12-31`;

  const overlays = [];
  let games = 0;
  for (const sportId of SPORT_IDS) {
    const url =
      `${API}/schedule?sportId=${sportId}&startDate=${start}&endDate=${end}&gameType=R` +
      `&hydrate=game(promotions),venue(location),team`;
    try {
      const data = await fetchJsonWithRetry(url);
      for (const d of data.dates || []) games += (d.games || []).length;
      overlays.push(...overlaysFromSchedule(data, places, today));
    } catch (err) {
      console.warn(`MLB Stats API sportId=${sportId} failed: ${err.message}`);
    }
  }
  console.log(`MLB/MiLB: ${games} scheduled games scanned, ${overlays.length} with a military promotion near a curated place.`);

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, "mlb-pr.json"), JSON.stringify(overlays));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.warn(`MLB promotions fetch skipped: ${err.message}`);
    process.exit(0);
  });
}
