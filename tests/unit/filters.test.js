import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilters } from "../../assets/js/filters.js";

const config = {
  origins: [
    { id: "vance", icao: "KEND" },
    { id: "sheppard", icao: "KSPS" },
  ],
  scoring: {
    scaleWeight: { flagship: 10, major: 6, notable: 3, local: 1 },
    favoriteArtistMultiplier: 2.5,
    proximityHalfLifeNm: 450,
    confidencePenalty: { confirmed: 1, "annual-estimate": 0.75, unconfirmed: 0.5 },
    rarityBoost: { annual: 1.4, seasonal: 1.1, recurring: 1 },
  },
};

const place = (id, distanceNm, extra = {}) => ({
  id, name: id, distanceNm, isWest: true, kinds: ["city"], activities: {}, airports: [{ icao: `K${id.toUpperCase()}` }], ...extra,
});

const places = () => [
  place("near", 100, { activities: { food: 4 } }),
  place("far", 900),
  place("east", 200, { isWest: false }),
  place("wichita", 96, { airports: [{ icao: "KSPS" }] }),
  place("bigcity", 300, { kinds: ["city"], activities: { weird: 4, food: 3, art: 3 } }),
  place("smalltown", 250, { kinds: ["boutique"], activities: { weird: 1, food: 2, art: 2, outdoors: 2 } }),
];

const ev = (id, placeId, start, extra = {}) => ({
  id, title: id, start, placeId, category: "art", scale: "local", confidence: "confirmed", ...extra,
});

const events = [
  ev("in-window", "near", "2026-10-10"),
  ev("before-window", "near", "2026-10-01"),
  ev("spans-into-window", "near", "2026-10-03", { end: "2026-10-06" }),
  ev("food-fest", "near", "2026-10-11", { category: "food", description: "barbecue and brisket" }),
  ev("too-far", "far", "2026-10-10"),
];

const baseState = (patch = {}) => ({
  originId: "vance",
  rangeNm: 600,
  westOnly: false,
  categories: new Set(),
  activities: new Set(),
  minScale: null,
  search: "",
  dateRange: { start: new Date(2026, 9, 5), end: new Date(2026, 10, 4) },
  ...patch,
});

const ids = (list) => list.map((x) => x.id).sort();

test("range, date window and overlap", () => {
  const { visiblePlaces, visibleEvents } = applyFilters(places(), events, baseState(), config);
  assert.ok(!ids(visiblePlaces).includes("far"));
  assert.deepEqual(ids(visibleEvents), ["food-fest", "in-window", "spans-into-window"]);
});

test("the selected base's own airport is not a destination", () => {
  assert.ok(ids(applyFilters(places(), events, baseState(), config).visiblePlaces).includes("wichita"));
  assert.ok(!ids(applyFilters(places(), events, baseState({ originId: "sheppard" }), config).visiblePlaces).includes("wichita"));
});

test("west-of-the-Mississippi rule", () => {
  const { visiblePlaces } = applyFilters(places(), events, baseState({ westOnly: true }), config);
  assert.ok(!ids(visiblePlaces).includes("east"));
});

test("Boutique activity uses the boutique gate, not the quirk score", () => {
  const { visiblePlaces } = applyFilters(places(), events, baseState({ activities: new Set(["weird"]) }), config);
  assert.deepEqual(ids(visiblePlaces), ["smalltown"]);
});

test("other activities need a 3+ curated score", () => {
  const { visiblePlaces } = applyFilters(places(), events, baseState({ activities: new Set(["food"]) }), config);
  assert.deepEqual(ids(visiblePlaces), ["bigcity", "near"]);
});

test("category filter and search", () => {
  const byCat = applyFilters(places(), events, baseState({ categories: new Set(["food"]) }), config);
  assert.deepEqual(ids(byCat.visibleEvents), ["food-fest"]);
  const bySearch = applyFilters(places(), events, baseState({ search: "BRISKET" }), config);
  assert.deepEqual(ids(bySearch.visibleEvents), ["food-fest"]);
});

test("visible events are in date order", () => {
  const { visibleEvents } = applyFilters(places(), events, baseState(), config);
  const starts = visibleEvents.map((e) => e.start);
  assert.deepEqual(starts, [...starts].sort());
});
