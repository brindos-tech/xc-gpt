import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFields, isPCoded, selectFields, fieldStatus, gfcStatus, perDiemFor, fiscalYear, telHref, matchesSearch, FIELD_FILTERS } from "../../assets/js/planner/fields.js";
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
const aircard = {
  airports: {
    KOKC: [
      { merchant: "AAR AIRCRAFT SERVICES", contract: true, onSite: true, fuels: ["Jet A"], phone: "+1 (405) 218-3150" },
      { merchant: "World Fuel Services", contract: false, onSite: false, fuels: ["Jet A"], phone: null },
    ],
    KPNC: [{ merchant: "Ponca Aviation", contract: false, onSite: true, fuels: ["Jet A"], phone: null }],
    KLAX: [{ merchant: "Atlantic", contract: true, onSite: true, fuels: [], phone: null }],
  },
};
const fields = mergeFields(nav, facts, aircard);
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
  assert.deepEqual(selectFields(fields, state({ fieldFilters: new Set(["dla"]) }), vance, config).fields.map((f) => f.code), ["KOKC"]);
  assert.deepEqual(selectFields(fields, state({ fieldFilters: new Set(["aircard"]) }), vance, config).fields.map((f) => f.code), ["KPNC", "KOKC"]);
  // RON and Towered are not toggles any more
  assert.deepEqual(FIELD_FILTERS.map((f) => f.key), ["fuel", "dla", "aircard", "t6", "fbo", "military"]);
  assert.equal(FIELD_FILTERS[0].label, "Fuel available");
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
  assert.equal(gfcStatus(fields[0]).level, "contract");
  assert.match(gfcStatus(fields[0]).text, /AAR AIRCRAFT SERVICES/);
  // KPNC: the list says No GFC and the export has only an open-market merchant — the list wins
  assert.equal(gfcStatus(fields[1]).level, "none");
  assert.equal(gfcStatus({ notes: "", aircard: [{ merchant: "X", contract: false, onSite: true }] }).level, "open");
  assert.equal(gfcStatus({ notes: "", aircard: [{ merchant: "X", contract: false, onSite: false }] }).level, "delivered");
  assert.equal(gfcStatus({ notes: "", aircard: [] }).level, "unknown");
  // a contract merchant against a "No GFC" note is flagged, not hidden
  const clash = gfcStatus({ notes: "- No GFC", aircard: [{ merchant: "Y", contract: true, onSite: true }] });
  assert.equal(clash.level, "contract");
  assert.equal(clash.conflict, true);
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

test("hotel links carry the city and one night from the trip date", async () => {
  const { hotelLinks } = await import("../../assets/js/planner/field-panel.js");
  const h = hotelLinks("Oklahoma City, OK", new Date(2026, 10, 30));
  assert.match(h.marriott, /Oklahoma%20City%2C%20OK/);
  assert.match(h.marriott, /fromDate=11%2F30%2F2026&toDate=12%2F01%2F2026/);
  assert.match(h.hilton, /arrivalDate=2026-11-30&departureDate=2026-12-01/);
});

test("distanceToGeometryNm: inside is 0, otherwise nearest edge", async () => {
  const { distanceToGeometryNm } = await import("../../assets/js/geo.js");
  const o = { lat: 36, lon: -97 };
  const box = (dLat, dLon, size) => ({ type: "Polygon", coordinates: [[[-97 + dLon, 36 + dLat], [-97 + dLon + size, 36 + dLat], [-97 + dLon + size, 36 + dLat + size], [-97 + dLon, 36 + dLat + size], [-97 + dLon, 36 + dLat]]] });
  assert.equal(distanceToGeometryNm(box(-1, -1, 2), o), 0);
  // a box whose south edge is 1° (≈60 nm) north of the origin
  const d = distanceToGeometryNm(box(1, -0.5, 1), o);
  assert.ok(Math.abs(d - 60) < 1, `got ${d}`);
  // an area wrapping the origin with a hole around it is outside
  const donut = { type: "Polygon", coordinates: [box(-2, -2, 4).coordinates[0], box(-1, -1, 2).coordinates[0]] };
  assert.ok(Math.abs(distanceToGeometryNm(donut, o) - Math.cos((36 * Math.PI) / 180) * 60) < 1); // nearest hole edge, 1° of longitude
  // a route passing 30' east of the origin
  const line = { type: "LineString", coordinates: [[-96.5, 35], [-96.5, 37]] };
  assert.ok(Math.abs(distanceToGeometryNm(line, o) - 0.5 * Math.cos((36 * Math.PI) / 180) * 60) < 0.5);
  assert.equal(distanceToGeometryNm(null, o), Infinity);
});
