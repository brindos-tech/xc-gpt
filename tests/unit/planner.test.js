import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFields, isPCoded, selectFields, fieldStatus, gfcStatus, perDiemFor, fiscalYear, telHref, matchesSearch } from "../../assets/js/planner/fields.js";
import { airspaceRows, airspaceTooltip } from "../../assets/js/planner/airspace.js";

const config = { aircraft: { cruiseKts: 300 } };
const vance = { lat: 36.3392, lon: -97.9166 };
const nav = {
  fields: [
    { code: "KOKC", name: "Will Rogers World Airport", city: "Oklahoma City, OK", land: "Approved", fuel: "Approved", ron: "Approved", classification: "P (with DoD tenant)", fbo: "AAR Aircraft Services", suitability: ["T-6", "T-1", "T-38"], notes: "" },
    { code: "KPNC", name: "Ponca City Regional Airport", city: "Ponca City, OK", land: "Approved", fuel: "See Comments", ron: "See Comments", classification: "Civil Airport (Non-P)", fbo: "", suitability: ["T-6", "T-1"], notes: "- No GFC" },
    { code: "KLAX", name: "Los Angeles International", city: "Los Angeles, CA", land: "See Comments", fuel: "Approved", ron: "Approved", classification: "P (with DoD tenant)", fbo: "Atlantic", suitability: ["T-6"], notes: "" },
    { code: "XXXX", name: "No position", city: "", land: "Approved", fuel: "Approved", ron: "Approved", classification: "Military", fbo: "", suitability: [], notes: "" },
  ],
};
const facts = {
  facts: {
    KOKC: { lat: 35.3931, lon: -97.6007, tower: "ATCT-TRACON", contractFuel: null, perDiem: { 2027: { area: "Oklahoma City", lodging: [110, 110, 110, 110, 110, 110, 110, 110, 110, 120, 120, 120], meals: 74 } } },
    KPNC: { lat: 36.7311, lon: -97.0998, tower: "NON-ATCT" },
    KLAX: { lat: 33.9425, lon: -118.408, tower: "ATCT" },
  },
};
const fields = mergeFields(nav, facts);
const state = (patch = {}) => ({ fieldSource: "nav", fieldFilters: new Set(), search: "", rangeNm: 600, ...patch });

test("merge joins facts and flags fields without a position", () => {
  assert.equal(fields.length, 4);
  assert.equal(fields.find((f) => f.code === "XXXX").hasPosition, false);
  assert.equal(fields.find((f) => f.code === "KOKC").tower, "ATCT-TRACON");
});

test("range, source and quick filters", () => {
  assert.deepEqual(selectFields(fields, state(), vance, config).fields.map((f) => f.code), ["KPNC", "KOKC"]);
  assert.deepEqual(selectFields(fields, state({ fieldSource: "p" }), vance, config).fields.map((f) => f.code), ["KOKC"]);
  assert.deepEqual(selectFields(fields, state({ fieldFilters: new Set(["fuel"]) }), vance, config).fields.map((f) => f.code), ["KOKC"]);
  assert.deepEqual(selectFields(fields, state({ fieldFilters: new Set(["towered"]) }), vance, config).fields.map((f) => f.code), ["KOKC"]);
  assert.equal(selectFields(fields, state({ rangeNm: 2000 }), vance, config).inRange, 3);
});

test("search finds a field past the range ring and marks it", () => {
  const { fields: hits } = selectFields(fields, state({ search: "los angeles" }), vance, config);
  assert.deepEqual(hits.map((f) => f.code), ["KLAX"]);
  assert.equal(hits[0].outOfRange, true);
  assert.equal(matchesSearch(fields[0], "aar okc"), true);
});

test("P-coded, status and GFC", () => {
  assert.equal(isPCoded(fields[0]), true);
  assert.equal(isPCoded(fields[1]), false);
  assert.equal(fieldStatus(fields[0]), "go");
  assert.equal(fieldStatus(fields[1]), "check");
  assert.equal(gfcStatus(fields[1]).has, false);
  assert.equal(gfcStatus(fields[0]).known, false);
  assert.equal(gfcStatus({ notes: "", contractFuel: true }).has, true);
});

test("per diem by fiscal year and month", () => {
  assert.equal(fiscalYear(new Date(2026, 9, 31)), 2027);
  assert.equal(fiscalYear(new Date(2027, 8, 30)), 2027);
  const okc = fields.find((f) => f.code === "KOKC");
  assert.deepEqual(perDiemFor(okc, new Date(2026, 10, 7)), { fy: 2027, area: "Oklahoma City", lodging: 120, meals: 74 });
  assert.equal(perDiemFor(okc, new Date(2027, 10, 7)), null); // FY2028 not published
  assert.equal(telHref("(405) 218-3150"), "tel:+14052183150");
});

test("airspace panel rows and tooltips", () => {
  const moa = { type: "MOA", name: "VANCE 1A MOA", bottom: "7,000 MSL", top: "FL180", times: "Mon-Fri", scheduler: { agency: "71 FTW", location: "Vance AFB, OK", phone: "448-7820" } };
  assert.match(airspaceTooltip(moa), /VANCE 1A MOA/);
  assert.deepEqual(airspaceRows(moa).map(([k]) => k), ["Altitudes", "Times of use", "Scheduling"]);
  const sr = { type: "SR", name: "SR-206", altitudes: "SFC to 1,500 AGL", scheduling: "97 OSS/OSK", hours: "0830-0230 Local" };
  assert.deepEqual(airspaceRows(sr).map(([k]) => k), ["Altitudes", "Hours", "Scheduling"]);
});
