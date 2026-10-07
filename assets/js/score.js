// Relevance scoring — pure functions, all weights read from config.scoring.
import { isHighlightEvent } from "./importance.js";
import { parseDate } from "./format.js";

// A non-favorite concert or a non-pro/non-SEC sports game contributes
// nothing to a place or weekend's ranking — see importance.js. They can
// still be browsed (subject to filters.js's horizon-based visibility gate)
// but they can never win a "suggested city" slot.
export function eventScore(event, place, scoring) {
  if (!isHighlightEvent(event)) return 0;
  const scaleW = scoring.scaleWeight[event.scale] ?? 1;
  const favMult = event.isFavoriteArtist ? scoring.favoriteArtistMultiplier : 1;
  const distanceNm = place ? place.distanceNm : 0;
  const proximity = Math.pow(2, -distanceNm / scoring.proximityHalfLifeNm);
  const confPenalty = scoring.confidencePenalty[event.confidence] ?? 1;
  const rarity = event.recurringId
    ? scoring.rarityBoost.annual
    : scoring.rarityBoost.recurring;

  return scaleW * favMult * proximity * confPenalty * rarity;
}

// Which event categories count toward each activity's event bonus. Without
// this, eventBonus summed over every event at a place regardless of category
// — for a place with a lot going on, that sum dwarfs the 0-10 spread of the
// curated baseScore and ends up nearly identical across all six activity
// tabs, so the ranking barely changes when you switch tabs. Nightlife and
// weird have no clean event-category counterpart, so they're intentionally
// scored on the curated place attribute alone.
const ACTIVITY_CATEGORIES = {
  "live-music": ["concert"],
  art: ["art"],
  food: ["food"],
  outdoors: ["outdoors", "fair"],
  nightlife: [],
  weird: [],
};

// The Boutique tab (the "weird" activity key) is meant for small towns with
// real character — not just any place that clears a nonzero curated score.
// Without a gate here, both big cities that simply don't rate high on
// quirkiness (Dallas, Tulsa, ...) and the bare-minimum military-hometown
// entries (added so nearby recreation is browsable for an assignment, not
// as real getaways — e.g. Altus OK, Radcliff KY) clutter the list. Require
// the "boutique" kind tag plus real texture on at least three activity
// axes, so a place needs more going for it than a flat floor profile (or
// one or two middling scores) to count as worth the trip.
export function isWorthABoutiqueVisit(place) {
  if (!place.kinds?.includes("boutique")) return false;
  const richAxes = Object.values(place.activities || {}).filter((v) => v >= 2).length;
  return richAxes >= 3;
}

/**
 * Rank places for a given activity key within the currently-visible event
 * set. Returns [{place, score, topEvent}] sorted descending.
 */
export function rankPlacesByActivity(places, eventsByPlace, activityKey, scoring) {
  const relevantCategories = new Set(ACTIVITY_CATEGORIES[activityKey] ?? []);
  const results = [];
  for (const place of places) {
    if (activityKey === "weird" && !isWorthABoutiqueVisit(place)) continue;
    const baseScore = (place.activities?.[activityKey] ?? 0) * 2;
    const events = (eventsByPlace.get(place.id) || []).filter((ev) => relevantCategories.has(ev.category));
    let eventBonus = 0;
    let topEvent = null;
    let topEventScore = -Infinity;
    for (const ev of events) {
      const s = eventScore(ev, place, scoring);
      eventBonus += s * 0.15; // stacking bonus, diminishing weight
      // only a highlight event (favorite artist / pro-or-SEC game) can be
      // shown as the "why" for a place — a non-favorite concert scores 0
      // and must never win this even by default when it's the only event.
      if (isHighlightEvent(ev) && s > topEventScore) {
        topEventScore = s;
        topEvent = ev;
      }
    }
    const distancePenalty = place.distanceNm / 200;
    const score = baseScore + eventBonus - distancePenalty;
    if (score > 0) {
      results.push({ place, score, topEvent, eventCount: events.length });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Generate weekend candidates (Fri-Sun) within a date window.
 * fridaysInRange: array of Date objects (Fridays)
 * eventsByWeekend: Map<fridayKey, Event[]>
 * overrides: { "YYYY-MM-DD": { placeId, note } }
 */
const CONTINUING_WEIGHT = 0.5;

export function rankWeekendCandidates(friday, weekendEvents, places, scoring, override, rangeNm) {
  const placesById = new Map(places.map((p) => [p.id, p]));
  const byPlace = new Map();

  for (const ev of weekendEvents) {
    const place = placesById.get(ev.placeId);
    if (!place) continue;
    // Half weight for an event already under way before this Friday: the
    // later weekends of a three-week stock show still count, but something
    // that only happens this weekend (Mardi Gras) should be able to beat it
    // instead of the same pick repeating week after week.
    const continuing = parseDate(ev.start) < friday;
    const s = eventScore(ev, place, scoring) * (continuing ? CONTINUING_WEIGHT : 1);
    if (!byPlace.has(ev.placeId)) {
      byPlace.set(ev.placeId, { place, score: 0, events: [], scores: [] });
    }
    const entry = byPlace.get(ev.placeId);
    entry.events.push(ev);
    entry.scores.push(s);
  }

  // A weekend is as good as its best reason to go, plus a little for what
  // else is on. Summing every event at full weight let volume win: a big
  // city with thirty club comedy shows outscored a flagship air show or
  // rodeo, because each of those small events counts as a highlight.
  const STACKING_WEIGHT = 0.15;
  for (const entry of byPlace.values()) {
    const best = Math.max(...entry.scores);
    const rest = entry.scores.reduce((a, b) => a + b, 0) - best;
    entry.score = best + STACKING_WEIGHT * Math.min(rest, best * 2);
    delete entry.scores;
  }

  // best-scoring event first within each place, so the "topEvents" summary
  // shown in the UI always leads with a highlight event (favorite artist /
  // pro-or-SEC game) when one exists, rather than whatever was pushed first.
  for (const entry of byPlace.values()) {
    entry.events.sort((a, b) => eventScore(b, entry.place, scoring) - eventScore(a, entry.place, scoring));
  }

  // a place with zero highlight events this weekend scores 0 — drop it
  // rather than surface it as a "Best Match" with nothing to justify the pick.
  let candidates = Array.from(byPlace.values())
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  // A locked pick still has to be a flight someone could actually take. This
  // list is resolved against the full curated place set (placesById), not
  // the caller's already-range-filtered one, precisely so it can still
  // recommend a place currently outside the selected radius — but
  // "recommend" doesn't mean "force past reachability". Gate it by the same
  // rule filters.js uses to decide what's in range at all
  // (place.distanceNm <= rangeNm); a pick past that line falls back to
  // however the weekend scored on its own, same as if no override existed.
  if (override) {
    const overridePlace = placesById.get(override.placeId);
    const reachable = overridePlace && (rangeNm == null || overridePlace.distanceNm <= rangeNm);
    if (reachable) {
      candidates = candidates.filter((c) => c.place.id !== override.placeId);
      const existingEntry = byPlace.get(override.placeId);
      candidates.unshift({
        place: overridePlace,
        score: Infinity,
        events: existingEntry ? existingEntry.events : [],
        manual: true,
        note: override.note,
      });
    }
  }

  return candidates.slice(0, 3);
}
