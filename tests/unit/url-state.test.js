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
    view: "feed", originId: "sheppard", rangeNm: 450, westOnly: true,
    categories: new Set(["food", "art"]), activities: new Set(["weird"]), search: "rodeo", selectedPlaceId: "taos-nm",
    dateRange: { start: new Date(2026, 9, 10), end: new Date(2026, 9, 20) },
  };
  const patch = hashToState(stateToHash(state), defaults);
  assert.equal(patch.view, "feed");
  assert.equal(patch.originId, "sheppard");
  assert.equal(patch.rangeNm, 450);
  assert.equal(patch.westOnly, true);
  assert.deepEqual([...patch.categories].sort(), ["art", "food"]);
  assert.deepEqual([...patch.activities], ["weird"]);
  assert.equal(patch.search, "rodeo");
  assert.equal(patch.selectedPlaceId, "taos-nm");
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
