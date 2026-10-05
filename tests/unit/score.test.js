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
