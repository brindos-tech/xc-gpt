import { test } from "node:test";
import assert from "node:assert/strict";
import { stateToHash, hashToState } from "../../assets/js/url-state.js";

const today = new Date(2026, 9, 5);
const defaults = {
  today,
  dateRange: { start: today, end: new Date(2026, 10, 4) },
};

test("state round-trips through the hash", () => {
  const state = {
    view: "events", originId: "sheppard", rangeNm: 450,
    categories: new Set(["food", "art"]), activities: new Set(["weird"]), search: "rodeo", selectedPlaceId: "taos-nm",
    fieldSource: "p", airspace: new Set(["MOA", "SR"]),
    selectedFieldId: "KOKC", selectedAirspaceId: "MOA:VANCE 1A MOA", tripDate: "2026-11-07",
    wxLayers: new Set(["cat", "lice"]), wxTime: "2026-11-07T15:00Z",
    dateRange: { start: new Date(2026, 9, 10), end: new Date(2026, 9, 20) },
  };
  const patch = hashToState(stateToHash(state), defaults);
  assert.equal(patch.view, "events");
  assert.equal(patch.originId, "sheppard");
  assert.equal(patch.rangeNm, 450);
  assert.deepEqual([...patch.categories].sort(), ["art", "food"]);
  assert.equal(patch.activities, undefined, "the activity filter is gone, so old act= links do nothing");
  assert.doesNotMatch(stateToHash(state), /act=/);
  assert.equal(patch.search, "rodeo");
  assert.equal(patch.selectedPlaceId, "taos-nm");
  assert.equal(patch.fieldSource, "p");
  assert.deepEqual([...patch.airspace].sort(), ["MOA", "SR"]);
  assert.equal(patch.selectedFieldId, "KOKC");
  assert.equal(patch.selectedAirspaceId, "MOA:VANCE 1A MOA");
  assert.equal(patch.tripDate, "2026-11-07");
  assert.deepEqual([...patch.wxLayers].sort(), ["cat", "lice"]);
  assert.equal(patch.wxTime, "2026-11-07T15:00Z");
  // "none" is how an empty overlay set survives the round trip
  assert.equal(hashToState(stateToHash({ ...state, wxLayers: new Set() }), defaults).wxLayers.size, 0);
  assert.equal(patch.dateRange.start.getTime(), new Date(2026, 9, 10).getTime());
  assert.equal(patch.dateRange.end.getTime(), new Date(2026, 9, 20).getTime());
});

test("a date window that has fully elapsed is dropped", () => {
  const patch = hashToState("#/v=map&from=2026-08-10&to=2026-09-09&origin=vance&r=800", defaults);
  assert.equal(patch.dateRange, undefined);
  assert.equal(patch.rangeNm, 800);
});

test("a window still running is restored", () => {
  const patch = hashToState("#/from=2026-09-20&to=2026-10-20", defaults);
  assert.equal(patch.dateRange.end.getTime(), new Date(2026, 9, 20).getTime());
});

test("pages that no longer exist land on the events page", () => {
  for (const v of ["map", "feed", "places", "artists"]) assert.equal(hashToState(`#/v=${v}`, defaults).view, "events");
  for (const v of ["planner", "weekends"]) assert.equal(hashToState(`#/v=${v}`, defaults).view, v);
  assert.equal(hashToState("#/v=reviews", defaults).view, "planner", "the Reviews page is gone for now");
});

test("garbled or out-of-range links are ignored instead of breaking the page", () => {
  const today = new Date(2026, 10, 5);
  const defaults = { ...baseDefaults(today) };
  const limits = { originIds: new Set(["vance", "columbus"]), rangeMin: 50, rangeMax: 2200 };
  assert.deepEqual(hashToState("#/v=planner&origin=randolph&r=abc", defaults, limits), { view: "planner" }, "unknown base and non-numeric range");
  assert.equal(hashToState("#/origin=columbus", defaults, limits).originId, "columbus");
  assert.equal(hashToState("#/r=9999", defaults, limits).rangeNm, undefined, "range outside the slider");
  assert.equal(hashToState("#/r=600", defaults, limits).rangeNm, 600);
  assert.equal(hashToState("#/from=garbage", defaults, limits).dateRange, undefined);
  assert.equal(hashToState("#/day=2026-02-30", defaults, limits).tripDate, undefined, "not a real date");
  assert.equal(hashToState("#/day=2026-11-01", defaults, limits).tripDate, undefined, "a trip day that has passed");
  assert.equal(hashToState("#/day=2026-11-14", defaults, limits).tripDate, "2026-11-14");
  assert.equal(hashToState("#/day=2026-11-14", defaults, limits).wxDay, "2026-11-14", "old links: the weather day follows the trip day");
  assert.equal(hashToState("#/day=2026-11-14&wd=2026-11-16", defaults, limits).wxDay, "2026-11-16");
});

test("the weather day rides in the link only when it differs from the trip day", () => {
  const base = { view: "planner", dateRange: { start: new Date(2026, 10, 5), end: new Date(2026, 10, 6) }, originId: "vance", rangeNm: 600, categories: new Set(), search: "", fieldSource: "nav", trip: [], tripReturn: true, tripReturnDep: "", approachTypes: new Set(), airspace: new Set(), wxLayers: new Set(), tripDate: "2026-11-07", wxDay: "2026-11-07" };
  assert.doesNotMatch(stateToHash(base), /wd=/);
  assert.match(stateToHash({ ...base, wxDay: "2026-11-09" }), /wd=2026-11-09/);
});

function baseDefaults(today) {
  return { today, dateRange: { start: today, end: today } };
}
