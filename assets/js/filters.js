// The single filter pipeline. Every view renders from this output — do not
// let a view filter independently, or views will drift out of sync.
import { parseDate } from "./format.js";
import { eventScore, isWorthABoutiqueVisit } from "./score.js";
import { isHighlightEvent } from "./importance.js";

function eventOverlapsRange(event, rangeStart, rangeEnd) {
  const evStart = parseDate(event.start);
  const evEnd = parseDate(event.end || event.start);
  return evStart <= rangeEnd && evEnd >= rangeStart;
}

function matchesSearch(text, query) {
  if (!query) return true;
  return text.toLowerCase().includes(query.toLowerCase());
}

export function applyFilters(places, events, state, config) {
  const origin = config.origins.find((o) => o.id === state.originId);

  // 1-3: place gates
  const visiblePlaces = places.filter((place) => {
    // A place served by the selected departure base is where you already
    // are, not a trip — Sheppard/Wichita Falls is the first origin that also
    // exists as a destination. Matched on ICAO rather than a distance
    // threshold so it stays exact: Wichita Falls is a legitimate 96 nm
    // destination from Vance and only stops being one when Sheppard is the
    // selected base.
    if (origin && place.airports?.some((a) => a.icao === origin.icao)) return false;
    if (place.distanceNm > state.rangeNm) return false;
    if (state.westOnly && !place.isWest) return false;
    if (state.activities.size > 0) {
      // The Boutique chip (the "weird" activity key) asks a different
      // question than the other five: not "does this place score high on
      // an axis" but "is this a small town worth the trip". A big city can
      // rate 3+ on the quirk axis (Austin, New Orleans, Memphis, Chicago)
      // without being boutique in any useful sense, and a real boutique
      // town can rate low on it (Bentonville scores 1). Defer to the same
      // gate the Places view's Boutique tab uses so the two agree.
      const hasActivity = Array.from(state.activities).some((a) =>
        a === "weird" ? isWorthABoutiqueVisit(place) : (place.activities?.[a] ?? 0) >= 3
      );
      if (!hasActivity) return false;
    }
    return true;
  });
  const visiblePlaceIds = new Set(visiblePlaces.map((p) => p.id));

  // 4-6: event gates
  const scaleOrder = { local: 0, notable: 1, major: 2, flagship: 3 };
  const minScaleRank = state.minScale ? scaleOrder[state.minScale] : -1;

  let visibleEvents = events.filter((ev) => {
    if (!visiblePlaceIds.has(ev.placeId)) return false;
    if (!eventOverlapsRange(ev, state.dateRange.start, state.dateRange.end)) return false;
    // "pr" is a tag, not a category: it admits any event carrying one,
    // alongside whatever real categories are also selected
    if (state.categories.size > 0 && !state.categories.has(ev.category) && !(ev.pr && state.categories.has("pr"))) {
      return false;
    }
    if (minScaleRank >= 0 && scaleOrder[ev.scale] < minScaleRank) return false;
    return true;
  });

  // 7: text search
  if (state.search) {
    const placeById = new Map(places.map((p) => [p.id, p]));
    visibleEvents = visibleEvents.filter((ev) => {
      const place = placeById.get(ev.placeId);
      const haystack = `${ev.title} ${place?.name || ""} ${ev.description || ""}`;
      return matchesSearch(haystack, state.search);
    });
  }

  // 8: score + sort
  const placeById = new Map(places.map((p) => [p.id, p]));
  const scored = visibleEvents
    .map((ev) => ({ event: ev, score: eventScore(ev, placeById.get(ev.placeId), config.scoring) }))
    .sort((a, b) => {
      const dateCompare = ev_start(a.event) - ev_start(b.event);
      if (dateCompare !== 0) return dateCompare;
      return b.score - a.score;
    });

  visibleEvents = scored.map((s) => s.event);

  // per-place event index for downstream views
  const eventsByPlace = new Map();
  for (const ev of visibleEvents) {
    if (!eventsByPlace.has(ev.placeId)) eventsByPlace.set(ev.placeId, []);
    eventsByPlace.get(ev.placeId).push(ev);
  }

  for (const place of visiblePlaces) {
    const evs = eventsByPlace.get(place.id) || [];
    place.eventCount = evs.length;
    // best-scoring first; a non-highlight event always scores 0 (see
    // score.js) so it only ever leads this list when nothing else at the
    // place qualifies as a highlight.
    place.rankedEvents = evs
      .slice()
      .sort((a, b) => eventScore(b, place, config.scoring) - eventScore(a, place, config.scoring));
    place.topEvent = place.rankedEvents[0] || null;
  }

  const counts = {
    placeCount: visiblePlaces.length,
    eventCount: visibleEvents.length,
    totalPlaceCount: places.length,
    totalEventCount: events.length,
  };

  return { visiblePlaces, visibleEvents, eventsByPlace, counts };
}

function ev_start(event) {
  return parseDate(event.start).getTime();
}

let lastHash = null;
let lastResult = null;

export function applyFiltersMemoized(places, events, state, config) {
  const hash = JSON.stringify({
    originId: state.originId,
    rangeNm: state.rangeNm,
    westOnly: state.westOnly,
    categories: Array.from(state.categories).sort(),
    activities: Array.from(state.activities).sort(),
    minScale: state.minScale,
    search: state.search,
    start: state.dateRange.start.getTime(),
    end: state.dateRange.end.getTime(),
  });
  if (hash === lastHash && lastResult) return lastResult;
  lastHash = hash;
  lastResult = applyFilters(places, events, state, config);
  return lastResult;
}
