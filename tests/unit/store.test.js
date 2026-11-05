import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../../assets/js/store.js";

const config = { defaultOriginId: "vance", defaults: { rangeNm: 600, horizonDays: 45 } };

test("reset filters: the filters reset, the page and the flight plan stay", async () => {
  const store = createStore(config, new Date(2026, 10, 5));
  store.setState({ view: "events", categories: new Set(["rodeo"]), search: "okc", rangeNm: 900, approachTypes: new Set(["ILS"]), trip: [{ code: "KPNC", ron: false }], tripDate: "2026-11-09", wxDay: "2026-11-10", tripReturnDep: "2026-11-09T15:00", originId: "columbus", fieldSource: "p" });
  store.reset();
  const s = store.getState();
  assert.equal(s.view, "events", "stays on the page you are on");
  assert.deepEqual(s.trip, [{ code: "KPNC", ron: false }], "the plan is kept");
  assert.equal(s.tripDate, "2026-11-09");
  assert.equal(s.wxDay, "2026-11-10");
  assert.equal(s.tripReturnDep, "2026-11-09T15:00");
  assert.equal(s.originId, "columbus", "the base stays while a plan is built from it");
  assert.equal(s.rangeNm, 600);
  assert.equal(s.search, "");
  assert.equal(s.categories.size, 0);
  assert.equal(s.approachTypes.size, 0);
});

test("reset filters with no plan also puts the base back", async () => {
  const store = createStore(config, new Date(2026, 10, 5));
  store.setState({ originId: "columbus", fieldSource: "p", rangeNm: 300 });
  store.reset();
  assert.equal(store.getState().originId, "vance");
  assert.equal(store.getState().fieldSource, "nav");
  assert.equal(store.getState().rangeNm, 600);
});
