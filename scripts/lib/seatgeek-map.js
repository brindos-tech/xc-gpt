// SeatGeek event -> our event record. Kept apart from fetch-seatgeek.js so
// the mapping can be unit tested without network access.
//
// SeatGeek tags each event with taxonomies, e.g.
//   [{ id: 1000000, name: "sports" }, { id: 1010100, name: "mlb", parent_id: 1000000 }]
// where the millions digit is the top-level family (1 sports, 2 concert,
// 3 theater). Specific names are checked first, then the family.
import { categoryFromTitle } from "./ticketmaster-map.js";

const NAME_CATEGORY = [
  [/^parking$/, null], // SeatGeek sells parking as its own "event"
  [/rodeo/, "rodeo"],
  [/music_festival/, "festival"],
  [/^(theater|broadway|classical|opera|dance|comedy|cirque|ballet)/, "art"],
  [/^(concert|music)/, "concert"],
];

const FAMILY_CATEGORY = { 1: "sports", 2: "concert", 3: "art" };

export function seatGeekCategory(event, unmapped) {
  const names = (event.taxonomies || []).map((t) => (t.name || "").toLowerCase());
  if (names.includes("parking") || event.type === "parking") return "misc";

  const byTitle = categoryFromTitle(event.title);
  if (byTitle) return byTitle;

  for (const name of [event.type, ...names].filter(Boolean)) {
    for (const [re, category] of NAME_CATEGORY) {
      if (re.test(name.toLowerCase())) return category ?? "misc";
    }
  }
  for (const t of event.taxonomies || []) {
    const family = FAMILY_CATEGORY[Math.floor((t.parent_id || t.id || 0) / 1000000)];
    if (family) return family;
  }
  if (unmapped) {
    const key = event.type || names.join("/") || "(none)";
    unmapped.set(key, (unmapped.get(key) || 0) + 1);
  }
  return "misc";
}

// SeatGeek's `score` (0..1) is its popularity signal — the one thing
// Ticketmaster can't give us (see estimateScale in fetch-ticketmaster.js).
// Thresholds are deliberately conservative until a few runs show the real
// distribution, which the fetch script logs.
export function scaleFromScore(score) {
  if (score >= 0.8) return "major";
  if (score >= 0.6) return "notable";
  return "local";
}

export function mapSeatGeekEvent(event, placeId, unmapped) {
  const date = (event.datetime_local || event.datetime_utc || "").slice(0, 10) || null;
  return {
    id: `sg-${event.id}`,
    title: event.title || event.short_title,
    start: date,
    end: date,
    startTime: event.time_tbd ? null : event.datetime_utc || null,
    placeId,
    venue: event.venue
      ? { name: event.venue.name, lat: Number(event.venue.location?.lat), lon: Number(event.venue.location?.lon) }
      : null,
    category: seatGeekCategory(event, unmapped),
    subcategory: event.type || null,
    scale: scaleFromScore(event.score ?? 0),
    attendance: null,
    artistIds: [],
    performerNames: (event.performers || []).map((p) => p.name).filter(Boolean),
    isFavoriteArtist: false,
    description: "",
    url: event.url || "",
    ticketUrl: event.url || "",
    source: "seatgeek",
    sourceId: String(event.id),
    confidence: "confirmed",
    fetchedAt: new Date().toISOString(),
    recurringId: null,
  };
}
