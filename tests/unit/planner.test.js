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

// ---- weather model ----
const wx = await import("../../assets/js/planner/wx-model.js");

const lv = (tC, cc, gphM) => ({ tC, cc, gphM });
const clearSky = [lv(10, 0, 110), lv(8, 0, 560), lv(5, 0, 1000), lv(2, 0, 1450), lv(-1, 0, 1950), lv(-8, 0, 3000), lv(-15, 0, 4200), lv(-25, 0, 5600), lv(-42, 0, 7200)];

test("wx: clear sky is VFR with no icing or ceiling", () => {
  const s = wx.deriveStep({ elevM: 300, t2mC: 15, rh2m: 40, visM: 24000, precipMm: 0, codes: [0], cape: 0, levels: clearSky });
  assert.equal(s.ceil, wx.NO_CEILING);
  assert.equal(s.lice + s.hice + s.thun, 0);
  assert.equal(wx.flightCategory(s.ceil, s.vis), 0);
  assert.equal(s.tF, 59);
});

test("wx: ceiling is the lowest cloudy level above ground; underground levels are ignored", () => {
  // 1000 and 950 hPa are below a 600 m field, 900 hPa (~1000 m) is overcast: ceiling ≈ (1000-600) m ≈ 1,300 ft
  const levels = clearSky.map((l, i) => (i === 2 ? lv(5, 90, 1000) : l));
  const s = wx.deriveStep({ elevM: 600, t2mC: 15, rh2m: 60, visM: 16000, precipMm: 0, codes: [3], cape: 0, levels: [lv(12, 100, 110), lv(10, 100, 560), ...levels.slice(2)] });
  assert.equal(s.ceil, 13);
  assert.equal(wx.flightCategory(s.ceil, s.vis), 1); // MVFR
});

test("wx: flight category thresholds", () => {
  assert.equal(wx.flightCategory(wx.NO_CEILING, 100), 0);
  assert.equal(wx.flightCategory(30, 100), 1); // 3,000 ft is MVFR
  assert.equal(wx.flightCategory(31, 100), 0);
  assert.equal(wx.flightCategory(9, 100), 2);
  assert.equal(wx.flightCategory(4, 100), 3);
  assert.equal(wx.flightCategory(wx.NO_CEILING, 9), 3); // under 1 SM
  assert.equal(wx.flightCategory(wx.NO_CEILING, 25), 2);
});

test("wx: low vs high icing split at 10,000 ft MSL", () => {
  // cloudy and −10 °C at 700 hPa (~3,000 m = 9,800 ft) is low icing; at 600 hPa (~4,200 m = 13,800 ft) high
  const low = clearSky.map((l, i) => (i === 5 ? lv(-8, 90, 3000) : l));
  const a = wx.deriveStep({ elevM: 0, t2mC: 5, rh2m: 80, visM: 10000, precipMm: 0, codes: [3], cape: 0, levels: low });
  assert.equal(a.lice, 2);
  assert.equal(a.hice, 0);
  const high = clearSky.map((l, i) => (i === 6 ? lv(-12, 60, 4200) : l));
  const b = wx.deriveStep({ elevM: 0, t2mC: 5, rh2m: 80, visM: 10000, precipMm: 0, codes: [3], cape: 0, levels: high });
  assert.equal(b.lice, 0);
  assert.equal(b.hice, 1);
  // too cold (−25 °C) or too warm is not icing
  const cold = clearSky.map((l, i) => (i === 7 ? lv(-25, 100, 5600) : l));
  assert.equal(wx.deriveStep({ elevM: 0, t2mC: 5, rh2m: 80, visM: 10000, precipMm: 0, codes: [3], cape: 0, levels: cold }).hice, 0);
});

test("wx: freezing rain, fog and thunder", () => {
  const base = { elevM: 0, t2mC: -1, rh2m: 90, visM: 8000, precipMm: 1, cape: 0, levels: clearSky };
  assert.equal(wx.deriveStep({ ...base, codes: [66] }).lice, 2);
  const fog = wx.deriveStep({ ...base, t2mC: 4, rh2m: 99, visM: 400, precipMm: 0, codes: [45] });
  assert.equal(fog.ceil, 2);
  assert.equal(wx.flightCategory(fog.ceil, fog.vis), 3);
  assert.equal(wx.deriveStep({ ...base, t2mC: 25, codes: [95] }).thun, 2);
  assert.equal(wx.deriveStep({ ...base, t2mC: 25, codes: [61], cape: 1500, precipMm: 3 }).thun, 2);
  assert.equal(wx.deriveStep({ ...base, t2mC: 25, codes: [61], cape: 600, precipMm: 1 }).thun, 1);
  assert.equal(wx.deriveStep({ ...base, t2mC: 25, codes: [61], cape: 3000, precipMm: 0 }).thun, 0);
});

test("wx: grid covers the bases and marks only in-range cells", () => {
  const origins = [{ lat: 36.3, lon: -97.9 }, { lat: 29.4, lon: -100.8 }];
  const g = wx.makeGrid(origins, 300);
  assert.equal(g.cov.length, g.nlat * g.nlon);
  const inRange = g.cov.filter(Boolean).length;
  assert.ok(inRange > 50 && inRange < g.cov.length, `${inRange} of ${g.cov.length}`);
  // the cell nearest each base is covered
  for (const o of origins) {
    const r = Math.round((o.lat - g.lat0) / g.step);
    const c = Math.round((o.lon - g.lon0) / g.step);
    assert.equal(g.cov[r * g.nlon + c], 1);
  }
  const p = wx.gridPoint(g, g.nlon + 2);
  assert.equal(p.lat, g.lat0 + 1);
  assert.equal(p.lon, g.lon0 + 2);
});

test("wx: buildWxFiles produces per-date files whose layers line up with steps and cells", () => {
  const times = Array.from({ length: 48 }, (_, h) => `2026-11-01T${String(h % 24).padStart(2, "0")}:00`.replace("2026-11-01", h < 24 ? "2026-11-01" : "2026-11-02"));
  const hourly = { time: times, temperature_2m: times.map(() => 15), relative_humidity_2m: times.map(() => 50), visibility: times.map(() => 20000), precipitation: times.map(() => 0), weather_code: times.map(() => 0), cape: times.map(() => 0) };
  for (const p of wx.LEVELS_HPA) {
    hourly[`temperature_${p}hPa`] = times.map(() => -5);
    hourly[`cloud_cover_${p}hPa`] = times.map(() => 0);
    hourly[`geopotential_height_${p}hPa`] = times.map(() => 100 + (1000 - p) * 12);
  }
  // 850 hPa overcast at 08Z on the 2nd only
  hourly.cloud_cover_850hPa = times.map((t) => (t === "2026-11-02T09:00" ? 100 : 0));
  const grid = wx.makeGrid([{ lat: 36, lon: -98 }], 120);
  const k = grid.cov.findIndex(Boolean);
  const loc = { elevation: 300, hourly };
  const files = wx.buildWxFiles({ grid, gridLocs: new Map([[k, loc]]), fieldLocs: new Map([["KEND", loc]]), times, model: "t", generatedAt: "now" });
  assert.deepEqual(files.index.dates, ["2026-11-01", "2026-11-02"]);
  assert.equal(files.index.steps.length, 16);
  assert.equal(files.index.grid.cov.length, grid.nlat * grid.nlon);
  const day2 = files.days["2026-11-02"];
  assert.equal(day2.steps.length, 8);
  assert.equal(day2.layers.ceil.length, 8);
  assert.equal(day2.layers.ceil[0].length, grid.nlat * grid.nlon);
  // step index 3 on the 2nd is 09Z: the fetched cell has a ceiling, unfetched cells have none
  assert.ok(day2.layers.ceil[3][k] < wx.NO_CEILING);
  assert.equal(day2.layers.ceil[3][k === 0 ? 1 : 0], wx.NO_CEILING);
  assert.equal(files.fields.fields.KEND.ceil.length, 16);
  assert.equal(files.fields.fields.KEND.tF[0], 59);
});

test("wx-data: step lookup by local date, bilinear sampling inside coverage only", async () => {
  const { createWxData } = await import("../../assets/js/planner/wx-data.js");
  const grid = { lat0: 30, lon0: -100, step: 1, nlat: 3, nlon: 3, cov: "111111110" }; // SE corner not covered
  const dayFile = { date: "2026-11-02", steps: ["2026-11-02T12:00Z"], layers: Object.fromEntries(["lice", "hice", "ceil", "vis", "prec", "thun"].map((l) => [l, [[0, 0, 0, 0, 0, 0, 0, 0, 0]]])) };
  dayFile.layers.prec = [[0, 10, 0, 0, 10, 0, 0, 0, 0]];
  const d = createWxData(async (p) => (p.includes("index.json") ? { generatedAt: "x", steps: ["2026-11-02T12:00Z"], dates: ["2026-11-02"], grid } : dayFile));
  assert.equal(await d.init(), true);
  await d.ensureSteps(["2026-11-02T12:00Z"]);
  // halfway between a 0 and a 10 cell
  assert.equal(d.sample(d.layerValues("2026-11-02T12:00Z", "prec"), 30, -99.5), 5);
  // outside the grid and inside an uncovered cell
  assert.equal(d.sample(d.layerValues("2026-11-02T12:00Z", "prec"), 40, -99.5), null);
  assert.equal(d.sample(d.layerValues("2026-11-02T12:00Z", "prec"), 32, -98, true), null);
  const p = d.pointAt("2026-11-02T12:00Z", 31, -99);
  assert.equal(p.prec, 10);
  // missing weather: init resolves false instead of throwing
  assert.equal(await createWxData(async () => { throw new Error("404"); }).init(), false);
});
