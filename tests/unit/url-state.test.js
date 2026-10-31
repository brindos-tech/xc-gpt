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
    fieldSource: "p", fieldFilters: new Set(["fuel", "t6"]), airspace: new Set(["MOA", "SR"]),
    selectedFieldId: "KOKC", selectedAirspaceId: "MOA:VANCE 1A MOA", tripDate: "2026-11-07",
    dateRange: { start: new Date(2026, 9, 10), end: new Date(2026, 9, 20) },
  };
  const patch = hashToState(stateToHash(state), defaults);
  assert.equal(patch.view, "events");
  assert.equal(patch.originId, "sheppard");
  assert.equal(patch.rangeNm, 450);
  assert.deepEqual([...patch.categories].sort(), ["art", "food"]);
  assert.deepEqual([...patch.activities], ["weird"]);
  assert.equal(patch.search, "rodeo");
  assert.equal(patch.selectedPlaceId, "taos-nm");
  assert.equal(patch.fieldSource, "p");
  assert.deepEqual([...patch.fieldFilters].sort(), ["fuel", "t6"]);
  assert.deepEqual([...patch.airspace].sort(), ["MOA", "SR"]);
  assert.equal(patch.selectedFieldId, "KOKC");
  assert.equal(patch.selectedAirspaceId, "MOA:VANCE 1A MOA");
  assert.equal(patch.tripDate, "2026-11-07");
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
  for (const v of ["map", "feed", "places", "artists", "weekends"]) assert.equal(hashToState(`#/v=${v}`, defaults).view, "events");
  assert.equal(hashToState("#/v=planner", defaults).view, "planner");
});
