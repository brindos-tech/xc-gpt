import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFields, isPCoded, selectFields, fieldStatus, gfcStatus, perDiemFor, fiscalYear, telHref, matchesSearch, FIELD_FILTERS } from "../../assets/js/planner/fields.js";
import { airspaceRows, airspaceTooltip } from "../../assets/js/planner/airspace.js";

const config = { aircraft: { cruiseKts: 300, legRangeNm: 400 } };
const vance = { lat: 36.3392, lon: -97.9166, icao: "KEND" };
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
  assert.deepEqual(FIELD_FILTERS.map((f) => f.key), ["fuel", "dla", "aircard", "t6", "fbo", "rated", "military"]);
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

// ---- approaches ----
const ap = await import("../../assets/js/planner/approaches.js");

test("approaches: chart names classify into training types", () => {
  const c = (n) => [...ap.classifyApproach(n)].sort();
  assert.deepEqual(c("ILS OR LOC RWY 17R"), ["ILS", "LOC"]);
  assert.deepEqual(c("ILS RWY 35"), ["ILS"]);
  assert.deepEqual(c("LOC RWY 8"), ["LOC"]);
  assert.deepEqual(c("LOC/DME RWY 8"), ["LOC"]);
  assert.deepEqual(c("LOC BC RWY 35"), ["LOCBC"]);
  assert.deepEqual(c("LOC/DME BC RWY 17"), ["LOCBC"]);
  assert.deepEqual(c("VOR/DME RWY 26"), ["VOR"]);
  assert.deepEqual(c("VOR-A"), ["CIRCLING", "VOR"]);
  assert.deepEqual(c("RNAV (GPS)-B"), ["CIRCLING", "RNAV"]);
  assert.deepEqual(c("RNAV (GPS) Y RWY 17"), ["RNAV"]); // a letter before RWY is not circling-only
  assert.deepEqual(c("TACAN RWY 31"), ["TACAN"]);
  assert.deepEqual(c("NDB RWY 4"), ["NDB"]);
  assert.deepEqual(c("HI-ILS OR LOC Z RWY 17"), ["HI"]);
  assert.deepEqual(c("HI-TACAN-J"), ["HI"]); // not "circling-only"
  assert.deepEqual(c("HI-LOC/DME BC RWY 33"), ["HI"]);
  assert.deepEqual(ap.approachTypes(["VOR-A", "ILS RWY 35", "LOC BC RWY 17"]), ["ILS", "LOCBC", "VOR", "CIRCLING"]);
});

test("approaches: fields filter on ALL selected types", () => {
  const withA = mergeFields(nav, facts, aircard, { airports: { KOKC: ["ILS RWY 35R", "LOC BC RWY 17L", "VOR-A"], KPNC: ["RNAV (GPS) RWY 17"] } });
  const sel = (types) => selectFields(withA, state({ approachTypes: new Set(types) }), vance, config).fields.map((f) => f.code);
  assert.ok(sel([]).includes("KOKC") && sel([]).includes("KPNC"), "no types selected = no filtering");
  assert.deepEqual(sel(["LOCBC"]), ["KOKC"]);
  assert.deepEqual(sel(["ILS", "LOCBC"]), ["KOKC"]);
  assert.deepEqual(sel(["ILS", "RNAV"]), []);
  assert.deepEqual(sel(["RNAV"]), ["KPNC"]);
  assert.deepEqual(withA.find((f) => f.code === "KOKC").approachTypes, ["ILS", "LOCBC", "VOR", "CIRCLING"]);
});

// ---- sun and hours ----
const sunmod = await import("../../assets/js/planner/sun.js");
const hoursmod = await import("../../assets/js/planner/hours.js");

test("sun: sunrise/sunset match known values within a few minutes, at the field's own time", () => {
  const near = (instant, tz, h, m) => {
    const got = sunmod.minutesOfDay(instant, tz);
    assert.ok(Math.abs(got - (h * 60 + m)) <= 4, `${sunmod.clock(instant, tz)} vs ${h}:${m}`);
  };
  const ny = sunmod.sunTimes("2026-06-21", 40.64, -73.78);
  near(ny.sunrise, "America/New_York", 5, 25);
  near(ny.sunset, "America/New_York", 20, 30);
  const la = sunmod.sunTimes("2026-12-21", 33.94, -118.41); // evening falls on the next UTC day
  near(la.sunrise, "America/Los_Angeles", 6, 54);
  near(la.sunset, "America/Los_Angeles", 16, 47);
  assert.ok(la.dusk > la.sunset && la.dawn < la.sunrise);
  assert.equal(sunmod.sunTimes("2026-06-21", 89, 0), null, "polar day has no sunset");
});

test("time zones: split states are decided by position; the abbreviation follows daylight time", () => {
  assert.equal(sunmod.fieldTimeZone("OK", 36.4, -97.9), "America/Chicago");
  assert.equal(sunmod.fieldTimeZone("TX", 31.8, -106.4), "America/Denver"); // El Paso
  assert.equal(sunmod.fieldTimeZone("TX", 29.4, -100.8), "America/Chicago"); // Del Rio
  assert.equal(sunmod.fieldTimeZone("FL", 30.4, -87.2), "America/Chicago"); // Pensacola
  assert.equal(sunmod.fieldTimeZone("FL", 27.9, -82.5), "America/New_York");
  assert.equal(sunmod.fieldTimeZone("AZ", 33.4, -112), "America/Phoenix");
  assert.equal(sunmod.zoneAbbr(new Date("2026-07-01T18:00:00Z"), "America/Chicago"), "CDT");
  assert.equal(sunmod.zoneAbbr(new Date("2026-11-07T18:00:00Z"), "America/Chicago"), "CST");
  assert.equal(sunmod.tzOffsetMin("America/Chicago", new Date("2026-07-01T18:00:00Z")), -300);
});

test("hours: FAA attendance text read for a weekday, with Z times converted", () => {
  const chi = "America/Chicago";
  const at = (t, day) => hoursmod.hoursForDay(t, day, chi);
  const SAT = "2026-11-07";
  const MON = "2026-11-09";
  assert.equal(at("24/7", SAT).kind, "always");
  assert.equal(at("MON-FRI 0800-1700", SAT).kind, "closed");
  assert.deepEqual(at("MON-FRI 0800-1700", MON), { kind: "open", openMin: 480, closeMin: 1020 });
  assert.deepEqual(at("0600-2200", SAT), { kind: "open", openMin: 360, closeMin: 1320 });
  assert.deepEqual(at("MON-FRI 0700-2300; SAT-SUN 0700-2100", SAT), { kind: "open", openMin: 420, closeMin: 1260 });
  // 1600Z-0000Z on a Saturday in CST (UTC-6) is 10:00 AM-6:00 PM
  assert.deepEqual(at("MON-FRI 1400-0400Z++; SAT-SUN 1600-0000Z++", SAT), { kind: "open", openMin: 600, closeMin: 1080 });
  assert.equal(at("MON-THU 1530-0800Z; FRI 1630-0200Z++; SAT CLSD; SUN 2200-0200Z++; HOL CLSD", SAT).kind, "closed");
  assert.equal(at("MON 1500-0200Z+; TUE-THU 1600-0200Z+; FRI 1600-0000Z+; CLSD SAT, SUN AND HOL.", SAT).kind, "closed");
  assert.equal(at("UNATNDD", SAT).kind, "unknown");
  assert.equal(at("MON-FRI", SAT).kind, "unknown", "days with no times is not guessed at");
  assert.equal(at("", SAT).kind, "unknown");
  assert.equal(at("APR-OCT 0700-2000; NOV-MAR 0700-1900", SAT).closeMin, 1140, "picks the season");
  assert.equal(hoursmod.fmtMin(1020), "5:00 PM");
  assert.equal(hoursmod.fmtMin(1500), "1:00 AM");
});

test("field sheet helper: closed weekend and closing before sunset are flagged", async () => {
  const { sunHours } = await import("../../assets/js/planner/field-panel.js");
  const f = { lat: 36.38, lon: -97.79, state: "OK", attendance: "MON-FRI 0800-1700" };
  const sat = sunHours(f, new Date(2026, 10, 7));
  assert.equal(sat.hours.kind, "closed");
  assert.ok(sat.flags.some((x) => x.level === "bad"));
  const mon = sunHours(f, new Date(2026, 10, 9)); // sunset ≈ 5:27 PM, FBO closes at 5:00 PM
  assert.ok(mon.flags.some((x) => /before sunset/.test(x.text)));
  assert.match(mon.sunText, /Sunset 5:\d\d PM/);
  assert.equal(sunHours({ lat: null, lon: null }, new Date()), null);
});

// ---- state lodging tax (GSA SmartPay) ----
test("state tax data: every state and DC, valid statuses, GSA links; sheet shows the badge only when exempt", async () => {
  const { readFileSync } = await import("node:fs");
  const tax = JSON.parse(readFileSync("data/curated/state-tax.json", "utf-8"));
  const codes = Object.keys(tax.states);
  assert.equal(codes.length, 51);
  for (const [code, t] of Object.entries(tax.states)) {
    assert.ok(["exempt", "form", "cba", "sales"].includes(t.status), `${code} status`);
    assert.match(t.url, /^https:\/\/smartpay\.gsa\.gov\/smarttax\/tax-information-by-state\/[a-z-]+$/);
    assert.ok(t.note.length > 20);
  }
  assert.equal(tax.states.OR.status, "exempt");
  assert.equal(tax.states.KS.status, "cba");
  assert.equal(tax.states.OK.status, "sales", "Oklahoma: nothing lodging-specific listed");

  const { fieldHtml } = await import("../../assets/js/planner/field-panel.js");
  const base = { code: "KXXX", name: "Test Field", city: "Testville, TX", classification: "Civil", land: "Approved", fuel: "Approved", ron: "Approved", lat: 31, lon: -100, state: "TX", approvalList: "None", suitability: [], aircard: [], approaches: [] };
  const ctx = (st) => ({ origin: vance, config, tripDate: new Date(2026, 10, 7), stateTax: tax.states[st], stateTaxAsOf: tax.asOf });
  const tx = fieldHtml(base, ctx("TX"));
  assert.match(tx, /Texas: lodging tax exempt \(form\)/);
  assert.match(tx, /Form 12-302/);
  const ok = fieldHtml({ ...base, state: "OK" }, ctx("OK"));
  assert.doesNotMatch(ok, /lodging tax exempt/);
  assert.match(ok, /No lodging exemption listed/);
  const ks = fieldHtml({ ...base, state: "KS" }, ctx("KS"));
  assert.match(ks, /centrally billed account only/);
  assert.doesNotMatch(ks, /Kansas: lodging tax exempt/);
});

// ---- TFR feed ----
test("tfr: WFS shapes merge with the list's types into slim features", async () => {
  const { buildTfr, notamId } = await import("../../scripts/fetch-tfr.js");
  assert.equal(notamId("6/4240-1-FDC-F"), "6/4240");
  const ring = [[-100.123456, 31.123456], [-100.1, 31.2], [-100.0, 31.1], [-100.123456, 31.123456]];
  const wfs = {
    features: [
      { geometry: { type: "Polygon", coordinates: [ring] }, properties: { NOTAM_KEY: "6/4240-1-FDC-F", TITLE: " SAN ANGELO, TX, Sunday ", STATE: "TX", LEGAL: "SECURITY", LAST_MODIFICATION_DATETIME: "202603052027" } },
      { geometry: { type: "Point", coordinates: [0, 0] }, properties: { NOTAM_KEY: "6/1-1-FDC-F" } },
      { geometry: { type: "Polygon", coordinates: [ring] }, properties: {} },
    ],
  };
  const out = buildTfr(wfs, [{ notam_id: "6/4240", type: "VIP" }]);
  assert.equal(out.length, 1, "points and entries without a NOTAM are dropped");
  assert.equal(out[0].properties.id, "TFR:6/4240");
  assert.equal(out[0].properties.kind, "VIP movement");
  assert.equal(out[0].properties.title, "SAN ANGELO, TX, Sunday");
  assert.deepEqual(out[0].geometry.coordinates[0][0], [-100.1235, 31.1235], "coordinates rounded to 4 places");
  assert.equal(buildTfr(wfs, [])[0].properties.kind, "Security", "falls back to the WFS class");
});

// ---- trip builder ----
test("trip: legs, range flags, route string and URL encoding", async () => {
  const trip = await import("../../assets/js/planner/trip.js");
  assert.equal(trip.encodeTrip([{ code: "KOKC", ron: true }, { code: "KTUL", ron: false }]), "KOKC*,KTUL");
  assert.deepEqual(trip.decodeTrip("KOKC*,KTUL,bad!,"), [{ code: "KOKC", ron: true }, { code: "KTUL", ron: false }]);
  const o = { icao: "KEND", lat: 36.3392, lon: -97.9166 };
  const stops = [{ code: "KOKC", lat: 35.39, lon: -97.6 }, { code: "KMSY", lat: 29.99, lon: -90.26 }];
  const r = trip.tripLegs(o, stops, config);
  assert.equal(r.legs.length, 3, "out, across, and back to base");
  assert.deepEqual(r.legs.map((l) => l.overRange), [false, true, true], "400 nm leg range");
  assert.ok(Math.abs(r.totalMins - r.legs.reduce((s, l) => s + (l.nm / 300) * 60, 0)) < 1e-6);
  assert.equal(trip.tripLegs(o, stops, config, false).legs.length, 2);
  assert.equal(trip.routeString(o, stops), "KEND KOKC KMSY KEND");
  assert.equal(trip.routeString(o, stops, false), "KEND KOKC KMSY");
});

test("trip: per diem — nights at each RON field, meals at 75% on the first and last day", async () => {
  const { tripPerDiem } = await import("../../assets/js/planner/trip.js");
  const field = (code, lodging, meals) => ({ code, perDiem: { 2027: { area: code, lodging: Array(12).fill(lodging), meals } } });
  const date = new Date(2026, 10, 7); // FY2027
  assert.deepEqual(tripPerDiem([{ field: field("KA", 100, 60), ron: false }], date), { nights: 0, days: 1, lodging: 0, meals: 0, total: 0, missing: [] });
  // one night: 2 days, both 75%
  const one = tripPerDiem([{ field: field("KA", 100, 60), ron: true }], date);
  assert.equal(one.nights, 1);
  assert.equal(one.lodging, 100);
  assert.equal(one.meals, 90);
  assert.equal(one.total, 190);
  // two nights at different rates: 3 days — 0.75 × A, 1.0 × B, 0.75 × B
  const two = tripPerDiem([{ field: field("KA", 100, 60), ron: true }, { field: field("KB", 150, 80), ron: true }], date);
  assert.equal(two.lodging, 250);
  assert.equal(two.meals, 0.75 * 60 + 80 + 0.75 * 80);
  const missing = tripPerDiem([{ field: { code: "KZ" }, ron: true }], date);
  assert.deepEqual(missing.missing, ["KZ"]);
});

test("trip: the crew card carries the legs, each stop's phone and approvals, and the disclaimer", async () => {
  const { crewCardHtml } = await import("../../assets/js/planner/crew-card.js");
  const trip = await import("../../assets/js/planner/trip.js");
  const f = fields.find((x) => x.code === "KOKC");
  const stops = [{ field: { ...f, state: "OK", lat: 35.39, lon: -97.6 }, ron: true }];
  const html = crewCardHtml({
    origin: vance,
    stops,
    legs: trip.tripLegs(vance, [stops[0].field], config),
    cost: trip.tripPerDiem(stops, new Date(2026, 10, 7)),
    tripDate: new Date(2026, 10, 7),
    route: trip.routeString(vance, [stops[0].field]),
    stateTaxes: { OK: { name: "Oklahoma", status: "sales", note: "GSA lists CBA exempt.", url: "x" } },
    dataNotes: ["Nav list 2026-09-28"],
  });
  assert.match(html, /Crew card · KEND/);
  assert.match(html, /KEND KOKC KEND/);
  assert.match(html, /1\. KOKC/);
  assert.match(html, /AAR AIRCRAFT SERVICES/i);
  assert.match(html, /Planning reference only/);
  assert.match(html, /Nav list 2026-09-28/);
});
