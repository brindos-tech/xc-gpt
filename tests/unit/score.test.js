import { test } from "node:test";
import assert from "node:assert/strict";
import { isWorthABoutiqueVisit, rankWeekendCandidates } from "../../assets/js/score.js";
import { isHighlightEvent } from "../../assets/js/importance.js";

const scoring = {
  scaleWeight: { flagship: 10, major: 6, notable: 3, local: 1 },
  favoriteArtistMultiplier: 2.5,
  proximityHalfLifeNm: 450,
  confidencePenalty: { confirmed: 1, "annual-estimate": 0.75, unconfirmed: 0.5 },
  rarityBoost: { annual: 1.4, seasonal: 1.1, recurring: 1 },
};

test("boutique needs the kind tag and three rich axes", () => {
  assert.equal(isWorthABoutiqueVisit({ kinds: ["boutique"], activities: { a: 2, b: 2, c: 3 } }), true);
  assert.equal(isWorthABoutiqueVisit({ kinds: ["boutique"], activities: { a: 2, b: 2, c: 1 } }), false);
  assert.equal(isWorthABoutiqueVisit({ kinds: ["city"], activities: { a: 5, b: 5, c: 5 } }), false);
});

test("non-favourite concerts and minor-league games are not highlights", () => {
  assert.equal(isHighlightEvent({ category: "concert", isFavoriteArtist: false }), false);
  assert.equal(isHighlightEvent({ category: "concert", isFavoriteArtist: true }), true);
  assert.equal(isHighlightEvent({ category: "sports", title: "Kansas City Chiefs vs. Denver Broncos" }), true);
  assert.equal(isHighlightEvent({ category: "sports", title: "Tulsa Drillers vs. Arkansas Travelers" }), false);
  assert.equal(isHighlightEvent({ category: "food" }), true);
});

const places = [
  { id: "near", distanceNm: 100 },
  { id: "far", distanceNm: 900 },
];
const friday = new Date(2026, 9, 9);
const weekendEvents = [{ id: "e1", placeId: "near", category: "art", scale: "major", confidence: "confirmed", start: "2026-10-10" }];

test("weekend pick ranks scored places", () => {
  const [primary] = rankWeekendCandidates(friday, weekendEvents, places, scoring, null, 600);
  assert.equal(primary.place.id, "near");
});

test("a locked override wins only when it is within range", () => {
  const override = { placeId: "far", note: "Locked pick" };
  assert.equal(rankWeekendCandidates(friday, weekendEvents, places, scoring, override, 1000)[0].place.id, "far");
  assert.equal(rankWeekendCandidates(friday, weekendEvents, places, scoring, override, 600)[0].place.id, "near");
});

test("curated festivals, fairs and rodeos are highlights; curated concerts still need a favorite", () => {
  assert.equal(isHighlightEvent({ category: "festival", curated: true }), true);
  assert.equal(isHighlightEvent({ category: "festival" }), false);
  assert.equal(isHighlightEvent({ category: "rodeo", curated: true }), true);
  assert.equal(isHighlightEvent({ category: "concert", curated: true, isFavoriteArtist: false }), false);
});

test("one flagship event beats a pile of small ones", () => {
  const ps = [{ id: "bigcity", distanceNm: 300 }, { id: "airshow-town", distanceNm: 400 }];
  const small = Array.from({ length: 30 }, (_, i) => ({
    id: `s${i}`, placeId: "bigcity", category: "art", scale: "local", confidence: "confirmed", start: "2026-10-10",
  }));
  const flagship = { id: "f", placeId: "airshow-town", category: "outdoors", scale: "flagship", confidence: "confirmed", start: "2026-10-10", recurringId: "air", curated: true };
  const [primary] = rankWeekendCandidates(friday, [...small, flagship], ps, scoring, null, 600);
  assert.equal(primary.place.id, "airshow-town");
});

test("more going on still breaks a tie", () => {
  const ps = [{ id: "a", distanceNm: 200 }, { id: "b", distanceNm: 200 }];
  const ev = (id, placeId) => ({ id, placeId, category: "art", scale: "major", confidence: "confirmed", start: "2026-10-10" });
  const [primary] = rankWeekendCandidates(friday, [ev("a1", "a"), ev("b1", "b"), ev("b2", "b")], ps, scoring, null, 600);
  assert.equal(primary.place.id, "b");
});

test("an event starting this weekend beats one already under way", () => {
  const ps = [{ id: "fw", distanceNm: 200 }, { id: "nola", distanceNm: 400 }];
  const stockShow = { id: "fw1", placeId: "fw", category: "rodeo", scale: "flagship", confidence: "confirmed", start: "2026-09-18", end: "2026-10-11", curated: true, recurringId: "s" };
  const mardiGras = { id: "mg", placeId: "nola", category: "festival", scale: "flagship", confidence: "confirmed", start: "2026-10-09", end: "2026-10-13", curated: true, recurringId: "m" };
  const [primary, backup] = rankWeekendCandidates(friday, [stockShow, mardiGras], ps, scoring, null, 600);
  assert.equal(primary.place.id, "nola");
  assert.equal(backup.place.id, "fw");
});
