#!/usr/bin/env node
// Ticketmaster Discovery API fetch. Free tier: 5,000 req/day, throttled to
// <=2 req/sec here. Two passes:
//   A. Artist pass — upcoming events for each cached attraction id.
//   B. Geographic pass — per-state, per-classification, rolling 90-day
//      window, for every state in the country. NOT a radius sweep:
//      Discovery API results cap at 1,000/query and the footprint is huge,
//      so state-by-state is the only way to get full coverage. Worst case
//      (51 regions x 4 classifications x 5 pages) is ~1,020 requests, well
//      inside the daily budget alongside the artist pass.
//
// Nationwide on purpose — the range slider goes up to ~2200nm (coast to
// coast from any of the departure bases), and a place only ever shows
// events if it's within 40nm of one of the curated entries in
// places.json, so widening this footprint only matters together with
// adding curated destinations to match.
//
// Requires env var TICKETMASTER_API_KEY (repo secret, CI-only).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fetchJsonWithRetry, createRateLimiter } from "./lib/http.js";
import { categorize } from "./lib/ticketmaster-map.js";

const CURATED_DIR = path.resolve("data/curated");
const CACHE_DIR = path.resolve(".cache");
const API_BASE = "https://app.ticketmaster.com/discovery/v2";
const API_KEY = process.env.TICKETMASTER_API_KEY;

const FOOTPRINT_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM",
  "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
];
// Query values must be spelled the way Ticketmaster spells its own
// classifications — this is a name match, not an enum. "arts&theatre"
// (no spaces) does not match the real segment, "Arts & Theatre".
//
// "miscellaneous" is where Ticketmaster files food & drink, fairs and
// festivals, and holiday events — the only Ticketmaster source for the Food
// category. Its unmappable remainder (expos, lectures, psychics) is still
// dropped as "misc" below.
const CLASSIFICATIONS = ["music", "sports", "arts & theatre", "miscellaneous"];

const limiter = createRateLimiter(2);

// "segment / genre" -> how many events fell through unmapped, for the
// summary main() prints. A future taxonomy rename should be obvious in the
// log instead of quietly deleting a whole category again.
const unmappedSegments = new Map();

// Venue capacity (used for the flagship/major/notable/local scale badge) is
// almost never present, even via the dedicated venue-detail endpoint — a
// live run found capacity for 0 of 1041 venues in this footprint. Ticketmaster
// just doesn't have that data for the vast majority of venues, so it can't be
// used as a popularity filter; scale ends up "local" for nearly everything
// and is cosmetic only.
function estimateScale(event) {
  const capacity = event._embedded?.venues?.[0]?.capacity;
  if (capacity >= 30000) return "flagship";
  if (capacity >= 8000) return "major";
  if (capacity >= 1000) return "notable";
  return "local";
}

function mapTicketmasterEvent(tmEvent, { placeId, attractionId } = {}) {
  const venue = tmEvent._embedded?.venues?.[0];
  const dateInfo = tmEvent.dates?.start;
  return {
    id: `tm-${tmEvent.id}`,
    title: tmEvent.name,
    start: dateInfo?.localDate || null,
    end: dateInfo?.localDate || null,
    startTime: dateInfo?.dateTime || null,
    placeId: placeId || null,
    venue: venue ? { name: venue.name, lat: Number(venue.location?.latitude), lon: Number(venue.location?.longitude) } : null,
    category: categorize(
      {
        segment: tmEvent.classifications?.[0]?.segment?.name,
        genre: tmEvent.classifications?.[0]?.genre?.name,
        title: tmEvent.name,
      },
      unmappedSegments
    ),
    subcategory: tmEvent.classifications?.[0]?.genre?.name || null,
    scale: estimateScale(tmEvent),
    attendance: null,
    artistIds: attractionId ? [attractionId] : [],
    isFavoriteArtist: false,
    description: tmEvent.info || "",
    url: tmEvent.url || "",
    ticketUrl: tmEvent.url || "",
    source: "ticketmaster",
    sourceId: tmEvent.id,
    confidence: "confirmed",
    fetchedAt: new Date().toISOString(),
    recurringId: null,
  };
}

async function findNearestPlace(lat, lon, places, maxNm = 40) {
  const { greatCircleNm } = await import("../assets/js/geo.js");
  let best = null;
  let bestDist = Infinity;
  for (const p of places) {
    const d = greatCircleNm({ lat, lon }, p);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return bestDist <= maxNm ? best : null;
}

async function fetchArtistEvents(artist, places) {
  if (!artist.ticketmasterAttractionId) return [];
  await limiter();
  const url = `${API_BASE}/events.json?apikey=${API_KEY}&attractionId=${artist.ticketmasterAttractionId}&startDateTime=${new Date().toISOString().split(".")[0]}Z`;
  try {
    const data = await fetchJsonWithRetry(url);
    const events = data._embedded?.events || [];
    const mapped = [];
    for (const ev of events) {
      const venue = ev._embedded?.venues?.[0];
      const lat = Number(venue?.location?.latitude);
      const lon = Number(venue?.location?.longitude);
      const place = Number.isFinite(lat) && Number.isFinite(lon) ? await findNearestPlace(lat, lon, places) : null;
      mapped.push(mapTicketmasterEvent(ev, { placeId: place?.id, attractionId: artist.ticketmasterAttractionId }));
    }
    return mapped;
  } catch (err) {
    console.warn(`Artist pass failed for ${artist.name}: ${err.message}`);
    return [];
  }
}

async function fetchStateEvents(stateCode, classificationName, places) {
  const events = [];
  let page = 0;
  const startDateTime = `${new Date().toISOString().split(".")[0]}Z`;
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 90);
  const endDateTime = `${endDate.toISOString().split(".")[0]}Z`;

  while (page < 5) {
    await limiter();
    const url =
      `${API_BASE}/events.json?apikey=${API_KEY}&stateCode=${stateCode}&countryCode=US` +
      `&classificationName=${encodeURIComponent(classificationName)}` +
      `&startDateTime=${startDateTime}&endDateTime=${endDateTime}&size=200&page=${page}`;
    try {
      const data = await fetchJsonWithRetry(url);
      const pageEvents = data._embedded?.events || [];
      if (pageEvents.length === 0) break;
      for (const ev of pageEvents) {
        const venue = ev._embedded?.venues?.[0];
        const lat = Number(venue?.location?.latitude);
        const lon = Number(venue?.location?.longitude);
        const place = Number.isFinite(lat) && Number.isFinite(lon) ? await findNearestPlace(lat, lon, places) : null;
        if (place) events.push(mapTicketmasterEvent(ev, { placeId: place.id }));
      }
      const totalPages = data.page?.totalPages ?? 1;
      page++;
      if (page >= totalPages) break;
    } catch (err) {
      console.warn(`Geo pass failed for ${stateCode}/${classificationName} page ${page}: ${err.message}`);
      break;
    }
  }
  return events;
}

async function main() {
  if (!API_KEY) {
    console.error("TICKETMASTER_API_KEY not set — skipping fetch, leaving .cache/ticketmaster.json untouched.");
    process.exit(0); // not a hard failure — merge.js tolerates a missing cache file
  }

  const [artists, places] = await Promise.all([
    readFile(path.join(CURATED_DIR, "artists.json"), "utf-8").then(JSON.parse),
    readFile(path.join(CURATED_DIR, "places.json"), "utf-8").then(JSON.parse),
  ]);

  const artistEventLists = await Promise.all(artists.map((a) => fetchArtistEvents(a, places)));
  const artistEvents = artistEventLists.flat();
  console.log(`Artist pass: ${artistEvents.length} events across ${artists.filter((a) => a.ticketmasterAttractionId).length} resolved artists.`);

  const geoEvents = [];
  for (const state of FOOTPRINT_STATES) {
    for (const classification of CLASSIFICATIONS) {
      const events = await fetchStateEvents(state, classification, places);
      geoEvents.push(...events);
    }
  }
  console.log(`Geographic pass: ${geoEvents.length} events across ${FOOTPRINT_STATES.length} states.`);

  // dedupe by ticketmaster sourceId before caching (artist pass and geo pass overlap)
  const bySourceId = new Map();
  for (const ev of [...artistEvents, ...geoEvents]) {
    if (!bySourceId.has(ev.sourceId)) bySourceId.set(ev.sourceId, ev);
  }
  const deduped = Array.from(bySourceId.values());

  // "misc" is whatever Ticketmaster's own classification couldn't place
  // into one of our categories (see lib/ticketmaster-map.js) — uncategorized noise the category
  // filter chips can't even target. Concerts, sports, and everything else
  // stay in: favorite-artist shows, pro sports, and legitimate touring acts
  // are all worth keeping, and venue capacity (the one signal that could
  // separate "big tour" from "bar show") isn't reliably present in
  // Ticketmaster's data to filter on further.
  const combined = deduped.filter((ev) => ev.category !== "misc");
  console.log(`Deduped to ${deduped.length} events, dropped ${deduped.length - combined.length} uncategorized ("misc") listings.`);

  // Anything here was thrown away. A segment we *expect* to keep showing up
  // in this list means the maps in lib/ticketmaster-map.js have drifted — that is
  // exactly how the arts catalogue went missing.
  if (unmappedSegments.size) {
    const breakdown = Array.from(unmappedSegments.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name} (${n})`)
      .join(", ");
    console.log(`Unmapped segment / genre pairs seen (pre-dedup): ${breakdown}`);
  }

  const kept = {};
  for (const ev of combined) kept[ev.category] = (kept[ev.category] || 0) + 1;
  console.log(`Kept by category: ${Object.entries(kept).map(([c, n]) => `${c} ${n}`).join(", ")}`);

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, "ticketmaster.json"), JSON.stringify(combined, null, 2));
  console.log(`Wrote ${combined.length} unique Ticketmaster events to .cache/ticketmaster.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
