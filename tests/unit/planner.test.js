import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFields, isPCoded, selectFields, fieldStatus, gfcStatus, perDiemFor, fiscalYear, telHref, matchesSearch, meetsRunway } from "../../assets/js/planner/fields.js";
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
const state = (patch = {}) => ({ fieldSource: "nav", search: "", rangeNm: 600, ...patch });

test("merge joins facts and flags fields without a position", () => {
  assert.equal(fields.length, 4);
  assert.equal(fields.find((f) => f.code === "XXXX").hasPosition, false);
  assert.equal(fields.find((f) => f.code === "KOKC").tower, "ATCT-TRACON");
});

test("range and source; fields with a known short runway are left off", () => {
  assert.deepEqual(selectFields(fields, state(), vance, config).fields.map((f) => f.code), ["KPNC", "KOKC"]);
  assert.deepEqual(selectFields(fields, state({ fieldSource: "p" }), vance, config).fields.map((f) => f.code), ["KOKC"]);
  assert.equal(selectFields(fields, state({ rangeNm: 2000 }), vance, config).inRange, 3);
  assert.equal(meetsRunway({ runway: { len: 3975 } }, 4000), false);
  assert.equal(meetsRunway({ runway: { len: 4000 } }, 4000), true);
  assert.equal(meetsRunway({ runway: { len: 9802 } }, 4000), true);
  assert.equal(meetsRunway({}, 4000), true, "an unknown runway length is kept, not guessed at");
  assert.equal(meetsRunway({ runway: null }, 4000), true);
});

test("search keeps every field in range, flags matches, and still finds one past the ring", () => {
  const none = selectFields(fields, state(), vance, config);
  const found = selectFields(fields, state({ search: "los angeles" }), vance, config);
  // nothing in range disappears; the out-of-range match is added, dimmed, and flagged
  for (const f of none.fields) assert.ok(found.fields.some((x) => x.code === f.code), `${f.code} stays on the map`);
  assert.equal(found.fields.length, none.fields.length + 1);
  assert.deepEqual(found.hits.map((f) => f.code), ["KLAX"]);
  assert.equal(found.hits[0].outOfRange, true);
  assert.equal(found.fields.find((f) => f.code === "KOKC").searchHit, false);
  // a match inside the ring is flagged without changing the count
  const near = selectFields(fields, state({ search: "will rogers" }), vance, config);
  assert.equal(near.fields.length, none.fields.length);
  assert.deepEqual(near.hits.map((f) => f.code), ["KOKC"]);
  assert.equal(near.inRange, none.inRange);
  // whitespace-only is not a search
  assert.equal(selectFields(fields, state({ search: "  " }), vance, config).hits.length, 0);
  assert.equal(matchesSearch(fields[0], "aar okc"), true);
});

test("field marks: towered blue, non-towered magenta, military gets a star", async () => {
  const { isTowered, isMilitary } = await import("../../assets/js/planner/fields.js");
  assert.equal(isTowered({ tower: "ATCT-TRACON" }), true);
  assert.equal(isTowered({ tower: "NON-ATCT" }), false);
  assert.equal(isTowered({}), false);
  assert.equal(isMilitary({ classification: "Military", ownership: "MA" }), true);
  assert.equal(isMilitary({ classification: "MIL/CIV" }), true);
  assert.equal(isMilitary({ classification: "P (with DoD tenant)", ownership: "PU" }), false, "a civil field with a DoD tenant is still civil");
  assert.equal(isMilitary({ classification: "Unlisted", ownership: "MN" }), true);
  const { pinSvg } = await import("../../assets/js/planner/planner-view.js");
  const blue = pinSvg({ towered: true, military: false, status: "go" });
  const pink = pinSvg({ towered: false, military: false, status: "no" });
  const mil = pinSvg({ towered: true, military: true, status: "check" });
  assert.match(blue, /#1d63d6/);
  assert.match(pink, /#c4188f/);
  assert.doesNotMatch(blue, /<polygon/);
  assert.match(mil, /<polygon/);
  assert.match(pink, /#e65a5a/, "the corner dot still carries approval status");
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
  assert.match(mon.sunText, /MCT \d+:\d\d AM · Sunrise .*ECT \d+:\d\d PM/);
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
  assert.equal(trip.encodeTrip([{ code: "KOKC", ron: true }, { code: "KTUL", ron: false }]), "KOKC,KTUL", "RON comes from the takeoff dates, not the link");
  assert.deepEqual(trip.decodeTrip("KOKC*,KTUL,bad!,"), [{ code: "KOKC", ron: false }, { code: "KTUL", ron: false }], "old links with a RON marker still open");
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
  // two nights at one field: one stop, nights: 2
  const stay = tripPerDiem([{ field: field("KA", 100, 60), ron: true, nights: 2 }], date);
  assert.equal(stay.nights, 2);
  assert.equal(stay.lodging, 200);
  assert.equal(stay.meals, 0.75 * 60 + 60 + 0.75 * 60);
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

test("clock helpers: wall-clock <-> instant in a zone, across daylight time", async () => {
  const { zonedInstant, wallClock } = await import("../../assets/js/planner/sun.js");
  const cst = zonedInstant("2026-11-07", "09:00", "America/Chicago");
  assert.equal(cst.toISOString(), "2026-11-07T15:00:00.000Z"); // CST, UTC-6
  const cdt = zonedInstant("2026-07-04", "09:00", "America/Chicago");
  assert.equal(cdt.toISOString(), "2026-07-04T14:00:00.000Z"); // CDT, UTC-5
  assert.deepEqual(wallClock(cst, "America/Denver"), { date: "2026-11-07", time: "08:00" });
  assert.deepEqual(wallClock(new Date("2026-11-08T03:30:00Z"), "America/Los_Angeles"), { date: "2026-11-07", time: "19:30" }, "the day rolls back west of UTC");
});

test("trip URL: takeoff times ride along with each stop", async () => {
  const trip = await import("../../assets/js/planner/trip.js");
  const stops = [{ code: "KOKC", ron: true, dep: "2026-11-07T09:30" }, { code: "KTUL", ron: false }];
  assert.equal(trip.encodeTrip(stops), "KOKC@202611070930,KTUL");
  assert.deepEqual(trip.decodeTrip("KOKC@202611070930,KTUL,junk,KXXX@12"), [{ code: "KOKC", ron: false, dep: "2026-11-07T09:30" }, { code: "KTUL", ron: false }]);
  // impossible times are dropped, not rolled into another day
  assert.deepEqual(trip.decodeTrip("KOKC@202613450000,KTUL@202611072561"), [{ code: "KOKC", ron: false }, { code: "KTUL", ron: false }]);
  assert.equal(trip.decodeDep("202602300900"), "");
  assert.equal(trip.isValidDate("2026-02-30"), false);
  assert.equal(trip.isValidDate("2028-02-29"), true);
  assert.equal(trip.decodeDep(trip.encodeDep("2026-11-08T17:05")), "2026-11-08T17:05");
  assert.equal(trip.decodeDep("nope"), "");
});

test("trip schedule: defaults chain from each landing, a later-day takeoff makes a RON, explicit times win, flags", async () => {
  const trip = await import("../../assets/js/planner/trip.js");
  const o = { icao: "KEND", lat: 36.3392, lon: -97.9166, tz: "America/Chicago" };
  const mk = (code, lat, lon, extra = {}) => ({ code, lat, lon, state: "OK", ...extra });
  const A = mk("KOKC", 35.39, -97.6, { attendance: "MON-FRI 0800-1700" });
  const B = mk("KTUL", 36.2, -95.9);
  const sched = (stops, extra = {}) => {
    const legs = trip.tripLegs(o, stops.map((s) => s.field), config).legs;
    return trip.scheduleTrip({ origin: o, stops, legs, tripDate: "2026-11-07", ...extra });
  };

  // no RON: leg 1 at 09:00 on the trip date, next leg an hour after landing (rounded up to 5 min), return likewise
  const day = sched([{ field: A, ron: false }, { field: B, ron: false }]);
  assert.equal(day.length, 3);
  assert.deepEqual([day[0].depLocal.date, day[0].depLocal.time], ["2026-11-07", "09:00"]);
  assert.ok(day[0].eta > day[0].dep && day[1].dep >= new Date(day[0].eta.getTime() + 60 * 60000));
  assert.ok(day[1].dep.getUTCMinutes() % 5 === 0, "rounded to 5 minutes");
  assert.ok(day.every((l) => !l.explicit));

  assert.ok(day.every((l) => !l.ron && l.nights === 0), "same-day legs are not RON");

  // a takeoff the next day makes the previous stop a RON (one night); two days later is two nights
  const night = sched([{ field: A, ron: false }, { field: B, ron: false, dep: "2026-11-08T09:00" }]);
  assert.deepEqual([night[0].ron, night[0].nights], [true, 1]);
  assert.deepEqual([night[1].ron, night[1].nights], [false, 0], "the next leg went back the same day");
  const nights2 = sched([{ field: A, ron: false }, { field: B, ron: false, dep: "2026-11-09T09:00" }]);
  assert.deepEqual([nights2[0].ron, nights2[0].nights], [true, 2]);
  // the return leg flown later makes the last stop a RON
  assert.equal(sched([{ field: A, ron: false }], { returnDep: "2026-11-08T08:00" })[0].ron, true);
  // no later leg, no RON
  assert.equal(night.at(-1).ron, false);

  // explicit: leg 2 on the 8th at 14:30, return left to automatic; leg 1's explicit value only supplies the time
  const set = sched([{ field: A, ron: false, dep: "2099-01-01T07:15" }, { field: B, ron: false, dep: "2026-11-08T14:30" }]);
  assert.deepEqual([set[0].depLocal.date, set[0].depLocal.time], ["2026-11-07", "07:15"], "leg 1 stays on the trip date");
  assert.deepEqual([set[1].depLocal.date, set[1].depLocal.time, set[1].explicit], ["2026-11-08", "14:30", true]);
  assert.ok(set[2].dep >= new Date(set[1].eta.getTime() + 60 * 60000));
  assert.equal(sched([{ field: A, ron: false }], { returnDep: "2026-11-09T08:00" })[1].depLocal.time, "08:00");

  // flags: Saturday arrival at a MON-FRI FBO; a night landing; overlapping legs
  assert.ok(trip.legFlags(day[0]).some((f) => /FBO closed that day/.test(f.text)));
  // Tulsa on Nov 7: sunset ≈ 5:25 PM, ECT ≈ 5:52 PM. Landing in civil twilight is not night.
  const twilight = sched([{ field: B, ron: false, dep: "2026-11-07T17:25" }]);
  assert.ok(twilight[0].etaLocal.time > "17:25" && twilight[0].etaLocal.time < "17:50");
  assert.equal(trip.legFlags(twilight[0]).some((f) => /night/.test(f.text)), false, "between sunset and ECT is still civil twilight");
  const late = sched([{ field: B, ron: false, dep: "2026-11-07T18:10" }]);
  assert.ok(trip.legFlags(late[0]).some((f) => /after ECT/.test(f.text) && /night/.test(f.text)), "an 18:10 takeoff lands after ECT");
  const early = sched([{ field: B, ron: false, dep: "2026-11-07T06:00" }]);
  assert.ok(trip.legFlags(early[0]).some((f) => /before MCT/.test(f.text)), "a 06:00 takeoff lands before MCT (~6:30)");
  const overlap = sched([{ field: A, ron: false }, { field: B, ron: false, dep: "2026-11-07T09:05" }]);
  assert.ok(trip.legFlags(overlap[1]).some((f) => /before the previous leg lands/.test(f.text)));
  assert.equal(trip.legFlags(day[2]).length, 0, "the base isn't checked");

  // lodging rate follows the night's date: December vs July rates differ
  const rate = { 2027: { area: "X", lodging: [90, 90, 90, 90, 90, 90, 90, 90, 90, 100, 110, 150], meals: 70 } };
  const F = { code: "KA", perDiem: rate };
  assert.equal(trip.tripPerDiem([{ field: F, ron: true, date: new Date(2026, 11, 20) }], new Date(2026, 10, 7)).lodging, 150);
  assert.equal(trip.tripPerDiem([{ field: F, ron: true }], new Date(2026, 10, 7)).lodging, 110, "no date: the trip date's month");
});

// ---- time zones and Zulu ----
test("clock helpers: Zulu, zone labels, and gaining/losing an hour", async () => {
  const sun = await import("../../assets/js/planner/sun.js");
  const dep = sun.zonedInstant("2026-11-07", "09:00", "America/Chicago");
  assert.equal(sun.zulu(dep).time, "1500Z");
  assert.equal(sun.zulu(dep).text, "Nov 7 1500Z");
  assert.equal(sun.zulu(new Date("2026-11-08T02:05:00Z")).date, "Nov 8", "the Zulu date can differ from the local date");
  assert.equal(sun.tzLabel("America/Chicago", dep), "Central (CST, UTC−6)");
  assert.equal(sun.tzLabel("America/Denver", sun.zonedInstant("2026-07-07", "09:00", "America/Denver")), "Mountain (MDT, UTC−6)");
  assert.equal(sun.tzLabel("America/Phoenix", sun.zonedInstant("2026-07-07", "09:00", "America/Phoenix")), "Mountain (MST, UTC−7)");
  const arr = new Date(dep.getTime() + 90 * 60000);
  assert.deepEqual(sun.clockShift("America/Chicago", dep, "America/Chicago", arr), { minutes: 0, kind: "none", text: "" });
  const west = sun.clockShift("America/Chicago", dep, "America/Denver", arr);
  assert.equal(west.kind, "gain");
  assert.equal(west.minutes, -60);
  assert.match(west.text, /Central → Mountain: gain 1 hr/);
  const east = sun.clockShift("America/Denver", dep, "America/New_York", arr);
  assert.equal(east.kind, "lose");
  assert.match(east.text, /lose 2 hr/);
});

test("crew card: time zones listed, shifts called out, local and Zulu on every leg", async () => {
  const { crewCardHtml } = await import("../../assets/js/planner/crew-card.js");
  const trip = await import("../../assets/js/planner/trip.js");
  const o = { icao: "KEND", lat: 36.3392, lon: -97.9166, tz: "America/Chicago" };
  const den = { code: "KDEN", name: "Denver Intl", city: "Denver, CO", state: "CO", lat: 39.86, lon: -104.67, land: "Approved", fuel: "Approved", ron: "Approved", classification: "Civil", aircard: [], approaches: [], approachTypes: [] };
  const stops = [{ field: den, ron: false }];
  const legs = trip.tripLegs(o, [den], config);
  const schedule = trip.scheduleTrip({ origin: o, stops, legs: legs.legs, tripDate: "2026-11-07" });
  const html = crewCardHtml({ origin: o, stops, legs, schedule, cost: trip.tripPerDiem(stops, new Date(2026, 10, 7)), tripDate: new Date(2026, 10, 7), route: trip.routeString(o, [den]), stateTaxes: {}, dataNotes: [] });
  assert.match(html, /Time zones — 2 zones on this trip/);
  assert.match(html, /KEND<\/td><td>Central \(CST, UTC−6\)/);
  assert.match(html, /KDEN<\/td><td>Mountain \(MST, UTC−7\)/);
  assert.match(html, /gain 1 hr/);
  assert.match(html, /Central → Mountain: gain 1 hr/);
  assert.match(html, /Nov 7 1500Z/, "takeoff in Zulu");
  assert.match(html, /<b>Nov 7 \d{4}Z<\/b>/, "landing in Zulu");
  assert.match(html, /Mountain → Central: lose 1 hr/, "and the way back");
  assert.doesNotMatch(html, /🕐|clocks go/, "no emoji or chatter");
  // a leg past 400 nm says so on the card
  const sea = { ...den, code: "KSEA", state: "WA", lat: 47.45, lon: -122.3 };
  const legsFar = trip.tripLegs(o, [sea], config);
  const schFar = trip.scheduleTrip({ origin: o, stops: [{ field: sea, ron: false }], legs: legsFar.legs, tripDate: "2026-11-07" });
  const far = crewCardHtml({ origin: o, stops: [{ field: sea, ron: false }], legs: legsFar, legRangeNm: 400, schedule: schFar, cost: trip.tripPerDiem([{ field: sea, ron: false }], new Date(2026, 10, 7)), tripDate: new Date(2026, 10, 7), route: trip.routeString(o, [sea]), stateTaxes: {}, dataNotes: [] });
  assert.match(far, /Tight on gas/);
  assert.doesNotMatch(html, /Tight on gas/, "a 380 nm leg is fine");
  // a single-zone trip says so
  const tul = { ...den, code: "KTUL", state: "OK", lat: 36.2, lon: -95.9 };
  const legs2 = trip.tripLegs(o, [tul], config);
  const sch2 = trip.scheduleTrip({ origin: o, stops: [{ field: tul, ron: false }], legs: legs2.legs, tripDate: "2026-11-07" });
  const html2 = crewCardHtml({ origin: o, stops: [{ field: tul, ron: false }], legs: legs2, schedule: sch2, cost: trip.tripPerDiem([], new Date()), tripDate: new Date(2026, 10, 7), route: "x", stateTaxes: {}, dataNotes: [] });
  assert.match(html2, /all one zone/);
  assert.doesNotMatch(html2, /you gain|you lose/);
});

test("runways: every one at least 4,000 x 75 ft is kept for the crew card", async () => {
  const { usableRunways } = await import("../../scripts/build-fields.js");
  const rows = [
    { RWY_ID: "17/35", RWY_LEN: "9217", RWY_WIDTH: "150", SURFACE_TYPE_CODE: "CONC" },
    { RWY_ID: "12/30", RWY_LEN: "6000", RWY_WIDTH: "100", SURFACE_TYPE_CODE: "ASPH" },
    { RWY_ID: "04/22", RWY_LEN: "3800", RWY_WIDTH: "75", SURFACE_TYPE_CODE: "ASPH" },
    { RWY_ID: "08/26", RWY_LEN: "5000", RWY_WIDTH: "60", SURFACE_TYPE_CODE: "ASPH" },
    { RWY_ID: "H1", RWY_LEN: "100", RWY_WIDTH: "100", SURFACE_TYPE_CODE: "CONC" },
  ];
  assert.deepEqual(usableRunways(rows).map((r) => r.id), ["17/35", "12/30"], "too short, too narrow and helipads are out");
  const { runwaysHtml } = await import("../../assets/js/planner/crew-card.js");
  assert.match(runwaysHtml({ runways: usableRunways(rows) }), /17\/35 · 9,217′ × 150′ CONC<br>12\/30 · 6,000′ × 100′ ASPH/);
  assert.match(runwaysHtml({ runway: { id: "17C/35C", len: 9217, width: 150, surface: "CONC" } }), /17C\/35C · 9,217′/, "older data: the longest runway");
  assert.equal(runwaysHtml({}), "");
});

test("NOTAMs: only show-stoppers are kept, and the crew card line says what it knows", async () => {
  const n = await import("../../assets/js/planner/notams.js");
  assert.equal(n.showStopper("!OKC 11/123 OKC RWY 17R/35L CLSD 2611011200-2611152359"), "Runway closed");
  assert.equal(n.showStopper("!PNC 11/001 PNC AD AP CLSD"), "Airport closed");
  assert.equal(n.showStopper("!PNC 11/002 PNC RWY 17 CLSD EXC EMERG"), "Runway closed");
  assert.equal(n.showStopper("!PNC 11/003 PNC AIRPORT CLOSED TO TRANSIENT"), "Airport closed");
  assert.equal(n.showStopper("!PNC 11/004 PNC AVGAS NOT AVBL"), "Fuel unavailable");
  assert.equal(n.showStopper("!PNC 11/005 PNC TWY B CLSD"), null, "taxiway closures are not show-stoppers");
  assert.equal(n.showStopper("!PNC 11/006 PNC RWY 17 EDGE LGT U/S"), null);
  // taxiway closures that merely mention a runway, and weight-limit closures, are not show-stoppers
  assert.equal(n.showStopper("TWY N RUNUP PAD FOR RWY 27 CLSD"), null);
  assert.equal(n.showStopper("TWY A BTN TWY C AND APCH END RWY 35 CLSD"), null);
  assert.equal(n.showStopper("RWY 09/27 CLSD TO ACFT OVER 12500 LBS"), null);
  assert.equal(n.showStopper("RWY 09/27 CLSD EXC TAX BTN TWY B3 AND TWY B7"), "Runway closed");
  assert.equal(n.showStopper("RWY 4 AND 22 CLSD"), "Runway closed");
  assert.equal(n.showStopper("!PNC 11/007 PNC OBST CRANE 150FT AGL"), null);
  // dates and items
  assert.equal(n.parseNotamDate("2611011200").toISOString(), "2026-11-01T12:00:00.000Z");
  assert.equal(n.parseNotamDate("PERM"), null);
  // dates as NMS sends them (YYYYMMDDHHMM) and the older ones
  assert.equal(n.parseNotamDate("202508210234").toISOString(), "2025-08-21T02:34:00.000Z");
  const closed = { location: "OKC", text: "RWY 17R/35L CLSD", start: "202611011200", end: "202611152359", type: "N", number: "11/123" };
  const got = n.keepShowStoppers([closed, { ...closed, type: "C" }, { ...closed, text: "OBST CRANE" }]);
  assert.equal(got.length, 1, "cancels and non-closures are dropped");
  assert.deepEqual([got[0].kind, got[0].start, got[0].end], ["Runway closed", "2026-11-01T12:00:00.000Z", "2026-11-15T23:59:00.000Z"]);
  // what the card prints: closures overlapping the stay (arrival -> next takeoff), including ones that begin later in it
  const mk = (kind, text, start, end) => ({ kind, text, number: "11/1", start, end });
  const file = {
    builtAt: "2026-11-03T12:00:00Z",
    checked: ["KOKC", "KPNC", "KTUL"],
    fields: {
      KOKC: [mk("Runway closed", "RWY 17R/35L CLSD", "2026-11-01T12:00:00.000Z", "2026-11-15T23:59:00.000Z")],
      KTUL: [
        mk("Airport closed", "AD AP CLSD", "2026-11-08T14:00:00.000Z", "2026-11-08T20:00:00.000Z"), // begins on day 2 of the stay
        mk("Runway closed", "RWY 18 CLSD", "2026-11-05T00:00:00.000Z", "2026-11-06T00:00:00.000Z"), // over before they arrive
        mk("Runway closed", "RWY 36 CLSD", "2026-11-12T00:00:00.000Z", null), // starts after they leave
      ],
    },
  };
  const arrive = new Date("2026-11-07T15:00:00Z");
  const leave = new Date("2026-11-09T15:00:00Z"); // a RON: two days
  assert.match(n.notamLines("KOKC", file, arrive, leave), /<b>Runway closed<\/b>: RWY 17R\/35L CLSD.*in force at arrival, until 11-15 23:59Z/);
  const tul = n.notamLines("KTUL", file, arrive, leave);
  assert.match(tul, /Airport closed<\/b>: AD AP CLSD/);
  assert.match(tul, /begins 11-08 14:00Z — during your stay/, "a closure that starts later in the stay is called out");
  assert.doesNotMatch(tul, /RWY 18|RWY 36/, "closures over before arrival or after departure are left out");
  assert.match(n.notamLines("KPNC", file, arrive, leave), /None found for your stay, 11-07 15:00Z – 11-09 15:00Z \(as of 2026-11-03 12:00Z\)/);
  assert.match(n.notamLines("KXYZ", file, arrive, leave), /not checked/);
  assert.match(n.notamLines("KOKC", null, arrive, leave), /not loaded/);
  assert.match(n.notamLines("KOKC", file, new Date("2026-12-01T00:00:00Z")), /None found/, "expired closures are not printed");
  assert.equal(n.overlapsWindow({ start: null, end: null }, arrive, leave), true, "no dates: in force until further notice");
});

test("crew card: elevation, who controls the field, and right-traffic runways are called out", async () => {
  const { controlInfo, rightTrafficText, crewCardHtml } = await import("../../assets/js/planner/crew-card.js");
  const { rightTrafficEnds, artccOf } = await import("../../scripts/build-fields.js");
  // data helpers
  assert.deepEqual(rightTrafficEnds([{ RWY_ID: "17/35", RWY_END_ID: "17", RIGHT_HAND_TRAFFIC_PAT_FLAG: "N" }, { RWY_ID: "17/35", RWY_END_ID: "35", RIGHT_HAND_TRAFFIC_PAT_FLAG: "Y" }, { RWY_ID: "H1", RWY_END_ID: "H1", RIGHT_HAND_TRAFFIC_PAT_FLAG: "Y" }]), ["35"]);
  assert.deepEqual(artccOf({ RESP_ARTCC_ID: "ZFW", RESP_ARTCC_NAME: "FORT WORTH CENTER" }), { id: "ZFW", name: "FORT WORTH" });
  assert.equal(artccOf({}), null);
  // who you talk to
  const zfw = { id: "ZFW", name: "FORT WORTH" };
  assert.match(controlInfo({ tower: "ATCT-TRACON", artcc: zfw }).text, /Tower \+ approach control \(TRACON\) · ZFW FORT WORTH Center/);
  assert.equal(controlInfo({ tower: "ATCT-RAPCON", artcc: zfw }).flagged, true);
  assert.match(controlInfo({ tower: "NON-ATCT", artcc: { id: "ZKC", name: "" } }).text, /ZKC Kansas City Center/, "the centre name comes from its id when the data has none");
  assert.match(controlInfo({ tower: "ATCT-A/C" }).text, /approach control \(A\/C\)/);
  assert.match(controlInfo({ tower: "NON-ATCT", artcc: zfw }).text, /No tower · center control \(ZFW FORT WORTH Center\)/);
  assert.equal(controlInfo({ tower: "NON-ATCT", artcc: zfw }).flagged, true);
  assert.deepEqual(controlInfo({ tower: "ATCT" }), { text: "Tower only, no approach control at the field", flagged: false });
  assert.equal(rightTrafficText({ rightTraffic: ["17", "35L"] }), "17, 35L");
  assert.equal(rightTrafficText({}), "");
  // on the card
  const trip = await import("../../assets/js/planner/trip.js");
  const o = { icao: "KEND", lat: 36.3392, lon: -97.9166, tz: "America/Chicago" };
  const f = { code: "KGCK", name: "Garden City Regional", city: "Garden City, KS", state: "KS", lat: 37.93, lon: -100.72, elevFt: 2891, tower: "NON-ATCT", artcc: { id: "ZKC", name: "KANSAS CITY" }, rightTraffic: ["12", "30"], runways: [{ id: "17/35", len: 7300, width: 100, surface: "ASPH" }], land: "Approved", fuel: "Approved", ron: "Approved", classification: "Civil", aircard: [], approaches: [], approachTypes: [] };
  const stops = [{ field: f, ron: false }];
  const legs = trip.tripLegs(o, [f], config);
  const schedule = trip.scheduleTrip({ origin: o, stops, legs: legs.legs, tripDate: "2026-11-07" });
  const html = crewCardHtml({ origin: o, stops, legs, schedule, cost: trip.tripPerDiem(stops, new Date(2026, 10, 7)), tripDate: new Date(2026, 10, 7), route: "x", stateTaxes: {}, dataNotes: [] });
  assert.match(html, /Elevation<\/th><td><b class="cc-hi">2,891′ MSL<\/b>/);
  assert.match(html, /ATC<\/th><td><b class="cc-hi">No tower · center control \(ZKC KANSAS CITY Center\)<\/b>/);
  assert.match(html, /Traffic pattern<\/th><td><b class="cc-hi">Right traffic: runway 12, 30<\/b>/);
});

test("crew card: each stop's hours, sun and per diem are for the day the crew arrives there", async () => {
  const { crewCardHtml } = await import("../../assets/js/planner/crew-card.js");
  const trip = await import("../../assets/js/planner/trip.js");
  const o = { icao: "KEND", lat: 36.3392, lon: -97.9166, tz: "America/Chicago" };
  // a weekday-only FBO: open Mon-Fri 0700-1700
  const f = { code: "KPNC", name: "Ponca City", city: "Ponca City, OK", state: "OK", lat: 36.73, lon: -97.1, attendance: "MON-FRI 0700-1700", land: "Approved", fuel: "Approved", ron: "Approved", classification: "Civil", aircard: [], approaches: [], approachTypes: [] };
  const a = { code: "KOKC", name: "Will Rogers", city: "Oklahoma City, OK", state: "OK", lat: 35.39, lon: -97.6, land: "Approved", fuel: "Approved", ron: "Approved", classification: "Civil", aircard: [], approaches: [], approachTypes: [] };
  // the trip starts Friday Nov 6; leg 2, to the weekday-only FBO, is set for Saturday Nov 7
  const stops = [{ field: a, ron: false }, { field: f, ron: false, dep: "2026-11-07T09:00" }];
  const legs = trip.tripLegs(o, [a, f], config);
  const schedule = trip.scheduleTrip({ origin: o, stops, legs: legs.legs, tripDate: "2026-11-06" });
  assert.equal(schedule[0].etaLocal.date, "2026-11-06");
  assert.equal(schedule[1].etaLocal.date, "2026-11-07");
  const html = crewCardHtml({ origin: o, stops, legs, schedule, cost: trip.tripPerDiem([], new Date(2026, 10, 6)), tripDate: new Date(2026, 10, 6), route: "x", stateTaxes: {}, dataNotes: [] });
  assert.match(html, /arrive Sat, Nov 7/);
  assert.match(html, /FBO hours<\/th><td>Closed that day/, "Saturday is not a weekday: the stop section says closed");
});

test("time zones: the split states are decided correctly for the fields on the list", async () => {
  const { fieldTimeZone } = await import("../../assets/js/planner/sun.js");
  const tz = (st, lat, lon) => fieldTimeZone(st, lat, lon);
  assert.equal(tz("ND", 48.4158, -101.358), "America/Chicago", "Minot AFB");
  assert.equal(tz("ND", 46.7727, -100.7457), "America/Chicago", "Bismarck");
  assert.equal(tz("ND", 46.797, -102.802), "America/Denver", "Dickinson");
  assert.equal(tz("ND", 48.178, -103.642), "America/Chicago", "Williston");
  assert.equal(tz("KY", 38.1741, -85.7365), "America/New_York", "Louisville");
  assert.equal(tz("KY", 37.686, -85.926), "America/New_York", "Elizabethtown");
  assert.equal(tz("KY", 38.0365, -84.6059), "America/New_York", "Lexington");
  assert.equal(tz("KY", 36.6686, -87.4962), "America/Chicago", "Fort Campbell");
  assert.equal(tz("KY", 36.9645, -86.4197), "America/Chicago", "Bowling Green");
  assert.equal(tz("KY", 37.0333, -85.9533), "America/Chicago", "Glasgow");
  // the other split states the list uses
  assert.equal(tz("KS", 37.93, -100.72), "America/Chicago", "Garden City");
  assert.equal(tz("SD", 44.05, -103.06), "America/Denver", "Rapid City");
  assert.equal(tz("TN", 35.04, -85.2), "America/New_York", "Chattanooga");
  assert.equal(tz("TN", 36.12, -86.68), "America/Chicago", "Nashville");
  assert.equal(tz("FL", 30.35, -87.32), "America/Chicago", "Pensacola");
  assert.equal(tz("FL", 30.07, -85.57), "America/Chicago", "Tyndall");
  assert.equal(tz("TX", 31.81, -106.38), "America/Denver", "El Paso");
});

test("crew card: the alternate warning is printed on the leg", async () => {
  const { crewCardHtml } = await import("../../assets/js/planner/crew-card.js");
  const trip = await import("../../assets/js/planner/trip.js");
  const o = { icao: "KEND", lat: 36.3392, lon: -97.9166, tz: "America/Chicago" };
  const f = { code: "KPNC", name: "Ponca City", city: "Ponca City, OK", state: "OK", lat: 36.73, lon: -97.1, land: "Approved", fuel: "Approved", ron: "Approved", classification: "Civil", aircard: [], approaches: [], approachTypes: [] };
  const stops = [{ field: f, ron: false }];
  const legs = trip.tripLegs(o, [f], config);
  const schedule = trip.scheduleTrip({ origin: o, stops, legs: legs.legs, tripDate: "2026-11-07" });
  const base = { origin: o, stops, legs, schedule, cost: trip.tripPerDiem([], new Date(2026, 10, 7)), tripDate: new Date(2026, 10, 7), route: "x", stateTaxes: {}, dataNotes: [] };
  const low = crewCardHtml({ ...base, forecastAt: (code) => (code === "KPNC" ? { ceil: 9, vis: 25, lice: 0, hice: 0, thun: 0 } : { ceil: 255, vis: 100 }) });
  assert.match(low, /Alternate may be required \(forecast ceiling 900 ft and visibility 2.5 SM at KPNC\)/);
  const fine = crewCardHtml({ ...base, forecastAt: () => ({ ceil: 255, vis: 100 }) });
  assert.doesNotMatch(fine, /Alternate may be required/);
});

test("untrusted text: tooltips are escaped and only web links are used", async () => {
  const { airspaceTooltip } = await import("../../assets/js/planner/airspace.js");
  const { esc, safeUrl } = await import("../../assets/js/planner/html.js");
  const evil = `<img src=x onerror=alert(1)>`;
  for (const p of [{ type: "TFR", name: evil, kind: evil, title: evil }, { type: "MOA", name: evil, bottom: evil, top: evil }, { type: "VR", name: evil, altitudes: evil }]) {
    const html = airspaceTooltip(p);
    assert.doesNotMatch(html, /<img/, `${p.type} tooltip`);
    assert.match(html, /&lt;img/);
  }
  assert.equal(safeUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeUrl("http://example.com"), "http://example.com");
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("  JaVaScRiPt:alert(1)"), "");
  assert.equal(safeUrl("data:text/html,<script>"), "");
  assert.equal(safeUrl(undefined), "");
  assert.equal(esc(`"><script>`), "&quot;&gt;&lt;script&gt;");
});

test("a field can be visited more than once: A to B to C, back to B, then home", async () => {
  const trip = await import("../../assets/js/planner/trip.js");
  const o = { icao: "KEND", lat: 36.3392, lon: -97.9166, tz: "America/Chicago" };
  const mk = (code, lat, lon) => ({ code, lat, lon, state: "OK" });
  const B = mk("KPNC", 36.73, -97.1);
  const C = mk("KOKC", 35.39, -97.6);
  // the plan: base -> B -> C -> B -> base
  const legs = trip.tripLegs(o, [B, C, B], config, true);
  assert.deepEqual(legs.legs.map((l) => `${l.from}>${l.to}`), ["KEND>KPNC", "KPNC>KOKC", "KOKC>KPNC", "KPNC>KEND"]);
  assert.equal(trip.routeString(o, [B, C, B], true), "KEND KPNC KOKC KPNC KEND");
  assert.ok(Math.abs(legs.legs[1].nm - legs.legs[2].nm) < 1e-6, "out and back are the same distance");
  // link round trip keeps both visits
  const link = trip.encodeTrip([{ code: "KPNC" }, { code: "KOKC" }, { code: "KPNC" }]);
  assert.equal(link, "KPNC,KOKC,KPNC");
  assert.deepEqual(trip.decodeTrip(link).map((x) => x.code), ["KPNC", "KOKC", "KPNC"]);
  // what a stop may not be: its neighbours (a leg from a field to itself is nothing)
  const stops = [{ code: "KPNC" }, { code: "KOKC" }];
  const has = (i, code, round = true) => trip.neighbourCodes(stops, i, round, "KEND").has(code);
  assert.equal(has(2, "KOKC"), true, "a new last stop cannot repeat the previous one");
  assert.equal(has(2, "KPNC"), false, "but can go back to an earlier field");
  assert.equal(has(2, "KEND"), true, "or be the base when the plan returns to the base anyway");
  assert.equal(has(2, "KEND", false), false, "one-way: the base is fine");
  assert.equal(has(0, "KEND"), true, "the first stop cannot be the base");
  assert.equal(has(0, "KOKC"), true, "nor the stop after it");
  assert.equal(has(1, "KPNC"), true, "editing stop 2: not the stop before");
  assert.equal(has(1, "KEND"), true, "last stop, returning home: not the base");
});

test("NMS AIXM: NOTAMs are read from the initial-load stream and matched to our fields", async () => {
  const { parseNotamMember, notamsFromChunks, buildLocationIndex, fieldCodeFor } = await import("../../scripts/lib/nms-aixm.js");
  const member = ({ number, year = 2026, type = "N", location, start, end, text, simple, icao = "", schedule = "" }) =>
    `<aixm:member><AIXMBasicMessage gml:id="NMS_ID_${number}"><hasMember><event:Event gml:id="Event_1"><gml:identifier codeSpace="urn:uuid:">x</gml:identifier><event:timeSlice><event:EventTimeSlice gml:id="T"><event:textNOTAM><event:NOTAM gml:id="NOTAM_1"><event:number>${number}</event:number><event:year>${year}</event:year><event:type>${type}</event:type><event:issued>2026-11-01T02:34:00.000Z</event:issued><event:location>${location}</event:location><event:effectiveStart>${start}</event:effectiveStart><event:effectiveEnd>${end}</event:effectiveEnd>${schedule ? `<event:schedule>${schedule}</event:schedule>` : ""}<event:text>${text}</event:text><event:translation><event:NOTAMTranslation gml:id="NT1"><event:type>LOCAL_FORMAT</event:type><event:simpleText>${simple}</event:simpleText></event:NOTAMTranslation></event:translation></event:NOTAM></event:textNOTAM><event:extension><fnse:EventExtension gml:id="e"><fnse:classification>DOM</fnse:classification><fnse:accountId>OKC</fnse:accountId>${icao ? `<fnse:icaoLocation>${icao}</fnse:icaoLocation>` : ""}</fnse:EventExtension></event:extension></event:EventTimeSlice></event:timeSlice></event:Event></hasMember></AIXMBasicMessage></aixm:member>`;
  const xml = [
    member({ number: 430, location: "8WC", start: "202508210234", end: "202510012359", text: "RWY 20 RWY END ID LGT U/S", simple: "!STL 08/430 8WC RWY 20 RWY END ID LGT U/S 2508210234-2510012359" }),
    member({ number: 101, location: "OKC", start: "202611071200", end: "202611082359", text: "RWY 17R/35L CLSD", simple: "!OKC 11/101 OKC RWY 17R/35L CLSD 2611071200-2611082359" }),
    member({ number: 7, location: "PNC", icao: "KPNC", start: "202611050000", end: "PERM", text: "AD AP CLSD &amp; ARPT NOT AVBL", simple: "!PNC 11/007 PNC AD AP CLSD &amp; ARPT NOT AVBL 2611050000-PERM" }),
    member({ number: 221, location: "ZBW", icao: "KZBW", start: "202505011100", end: "202511020001", schedule: "Daily:1100-0001~DLY 1100-0001", text: "AIRSPACE UAS WI AN AREA", simple: "!BDR 04/221 ZBW AIRSPACE UAS WI AN AREA" }),
  ].join("\n");
  const one = parseNotamMember(xml.split("</aixm:member>")[1] + "</aixm:member>");
  assert.deepEqual([one.number, one.location, one.start, one.end, one.type, one.classification], ["11/101", "OKC", "202611071200", "202611082359", "N", "DOM"]);
  assert.equal(one.text, "RWY 17R/35L CLSD");
  // read as a stream cut at arbitrary points
  const chunks = [];
  for (let i = 0; i < xml.length; i += 313) chunks.push(xml.slice(i, i + 313));
  const all = [];
  for await (const x of notamsFromChunks(chunks)) all.push(x);
  assert.equal(all.length, 4);
  assert.equal(all[2].text, "AD AP CLSD & ARPT NOT AVBL", "entities are decoded");
  assert.equal(all[2].end, "PERM");
  assert.equal(all[3].schedule, "Daily:1100-0001~DLY 1100-0001");
  // matched to our fields by FAA id or ICAO id; others (an ARTCC, an airport we do not use) are left alone
  const index = buildLocationIndex(["KOKC", "KPNC", "K79J", "1R8"], { KOKC: { faaId: "OKC" }, KPNC: { faaId: "PNC" } });
  assert.deepEqual(all.map((x) => fieldCodeFor(x, index)), [null, "KOKC", "KPNC", null]);
  const { keepShowStoppers } = await import("../../assets/js/planner/notams.js");
  assert.deepEqual(keepShowStoppers(all).map((x) => `${x.number} ${x.kind}`), ["11/101 Runway closed", "11/007 Airport closed"]);
});
