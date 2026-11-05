import { test } from "node:test";
import assert from "node:assert/strict";
import { ceilingSeries, legIsInstrument, worstSample, summarize, timelineSvg, sampleAt } from "../../assets/js/planner/ceiling-timeline.js";

const dep = new Date("2026-11-07T14:00:00Z");
const eta = new Date("2026-11-07T14:40:00Z");
// KIFR: 700 ft ceiling until 18:00Z, then 3,500 ft; KVFR: always clear
const forecastAt = (code, t) => {
  if (code === "KVFR") return { ceil: 255, vis: 100, lice: 0, hice: 0, thun: 0 };
  return t < new Date("2026-11-07T18:00:00Z") ? { ceil: 7, vis: 30, lice: 0, hice: 0, thun: 0 } : { ceil: 35, vis: 100, lice: 0, hice: 0, thun: 0 };
};

test("series runs from takeoff in half-hour steps; gaps are null", () => {
  const s = ceilingSeries(forecastAt, "KIFR", dep);
  assert.equal(s.length, 24);
  assert.equal(s[0].t.getTime(), dep.getTime());
  assert.equal(s[0].ceilFt, 700);
  assert.equal(s[0].cat, 2);
  assert.equal(ceilingSeries(forecastAt, "KVFR", dep)[0].ceilFt, null);
  assert.equal(ceilingSeries(() => null, "KNONE", dep), null);
  const partial = ceilingSeries((c, t) => (t < new Date("2026-11-07T15:00:00Z") ? forecastAt(c, t) : null), "KIFR", dep);
  assert.equal(partial[5], null);
});

test("only instrument legs get a timeline", () => {
  const ifr = ceilingSeries(forecastAt, "KIFR", dep);
  const vfr = ceilingSeries(forecastAt, "KVFR", dep);
  assert.equal(legIsInstrument(vfr, ifr, dep, eta), true, "IFR at the destination");
  assert.equal(legIsInstrument(ifr, vfr, dep, eta), true, "IFR at takeoff");
  assert.equal(legIsInstrument(vfr, vfr, dep, eta), false);
  assert.equal(legIsInstrument(null, null, dep, eta), false, "no forecast, no timeline");
  const late = new Date("2026-11-07T19:00:00Z"); // after it lifts
  assert.equal(legIsInstrument(ceilingSeries(forecastAt, "KIFR", late), vfr, late, new Date(late.getTime() + 2400000)), false);
});

test("summary says when it lifts, in the destination's local time", () => {
  const ifr = ceilingSeries(forecastAt, "KIFR", dep);
  assert.equal(sampleAt(ifr, eta).cat, 2);
  const text = summarize(ifr, eta, "America/Chicago");
  assert.match(text, /IFR at landing \(ceiling 700/);
  assert.match(text, /lifts to VFR by 12:00 PM CST/);
  assert.match(summarize(ceilingSeries(() => ({ ceil: 7, vis: 30 }), "X", dep), eta, "America/Chicago"), /stays instrument/);
});

test("svg has a bar per sample for each field and marks the landing", () => {
  const svg = timelineSvg({ rows: [{ label: "KIFR", series: ceilingSeries(forecastAt, "KIFR", dep) }, { label: "KVFR", series: ceilingSeries(forecastAt, "KVFR", dep) }], depAt: dep, etaAt: eta, tz: "America/Chicago" });
  assert.equal((svg.match(/opacity=/g) || []).length, 48);
  assert.match(svg, /class="tl-land"/);
  assert.match(svg, /role="img"/);
});

test("marginal VFR counts when asked, and the worst sample carries the ceiling", () => {
  const mvfr = (code, t) => ({ ceil: 22, vis: 100, lice: 0, hice: 0, thun: 0 }); // 2,200 ft = MVFR
  const s = ceilingSeries(mvfr, "KMV", dep);
  assert.equal(legIsInstrument(s, s, dep, eta), false, "IFR threshold by default");
  assert.equal(legIsInstrument(s, s, dep, eta, 1), true, "marginal counts with minCat 1");
  assert.deepEqual([worstSample(s, dep, eta).cat, worstSample(s, dep, eta).ceilFt], [1, 2200]);
  assert.equal(worstSample(ceilingSeries(forecastAt, "KVFR", dep), dep, eta), null, "all VFR: nothing to flag");
  const ifr = worstSample(ceilingSeries(forecastAt, "KIFR", dep), dep, eta);
  assert.deepEqual([ifr.cat, ifr.ceilFt], [2, 700]);
});

test("category colours: MVFR blue, IFR red, LIFR pink", async () => {
  const { CAT_COLORS, CAT_NAMES } = await import("../../assets/js/planner/wx-model.js");
  assert.deepEqual(CAT_NAMES, ["VFR", "MVFR", "IFR", "LIFR"]);
  assert.equal(CAT_COLORS[1], "#5b8def");
  assert.equal(CAT_COLORS[2], "#e65a5a");
  assert.equal(CAT_COLORS[3], "#ff7ac6");
});

test("forecast grid: the whole lower 48 is covered, ocean and neighbours are not", async () => {
  const { makeConusGrid } = await import("../../assets/js/planner/wx-model.js");
  const g = makeConusGrid();
  const covered = (lat, lon) => Boolean(g.cov[Math.round(lat - g.lat0) * g.nlon + Math.round(lon - g.lon0)]);
  for (const [name, lat, lon] of [["Seattle", 47.45, -122.3], ["Boston", 42.36, -71.0], ["Miami", 25.8, -80.3], ["Los Angeles", 33.94, -118.4], ["Caribou ME", 46.87, -68.0], ["Vance", 36.34, -97.9], ["Key West-ish", 25.0, -81.0], ["San Diego", 32.7, -117.2]]) assert.ok(covered(lat, lon), name);
  for (const [name, lat, lon] of [["Atlantic", 32, -68], ["Pacific", 36, -125], ["Gulf", 26, -90], ["Toronto", 43.7, -79.4], ["Mexico City", 19.4, -99.1]]) assert.ok(!covered(lat, lon), name);
  const n = g.cov.filter(Boolean).length;
  assert.ok(n > 800 && n < 1100, `cell count stays near today's cost (${n})`);
});

test("alternate check: a forecast ceiling under 2,000 ft or visibility under 3 SM near the ETA", async () => {
  const { alternateCheck, alternateReason } = await import("../../assets/js/planner/ceiling-timeline.js");
  const at = (ceilHundreds, vis = 100) => () => ({ ceil: ceilHundreds, vis });
  assert.equal(alternateCheck(at(15), "KX", eta).ceilHundreds, 15);
  assert.equal(alternateCheck(at(19), "KX", eta).ceilHundreds, 19);
  assert.equal(alternateCheck(at(20), "KX", eta), null, "2,000 ft exactly is not below 2,000");
  assert.equal(alternateCheck(at(255), "KX", eta), null, "no ceiling, good visibility");
  assert.equal(alternateCheck(() => null, "KX", eta), null, "no forecast, no flag");
  // visibility alone counts: no ceiling but half a mile
  const fog = alternateCheck(at(255, 5), "KX", eta);
  assert.deepEqual(fog, { ceilHundreds: null, visTenths: 5 });
  assert.equal(alternateReason(fog), "forecast visibility 0.5 SM");
  assert.equal(alternateCheck(at(255, 30), "KX", eta), null, "3 SM exactly is not below 3");
  assert.equal(alternateReason(alternateCheck(at(8, 20), "KX", eta)), "forecast ceiling 800 ft and visibility 2 SM");
  // lowest value in the hour either side of arrival counts, one that lifts well before does not
  const lifts = (code, t) => ({ ceil: t < new Date(eta.getTime() - 61 * 60000) ? 8 : 40, vis: 100 });
  assert.equal(alternateCheck(lifts, "KX", eta), null);
  const dips = (code, t) => ({ ceil: t > new Date(eta.getTime() + 20 * 60000) ? 12 : 40, vis: 100 });
  assert.equal(alternateCheck(dips, "KX", eta).ceilHundreds, 12);
});
