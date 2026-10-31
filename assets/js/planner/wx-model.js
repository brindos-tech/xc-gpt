// Weather model for the planner: turns Open-Meteo pressure-level forecasts
// into the handful of planning quantities we draw (icing, ceiling, flight
// category, precip, thunder). Dependency-free ES module shared by the Node
// build (scripts/fetch-wx.js) and the browser. These are MODEL-DERIVED
// estimates from a coarse grid and ~1,500 ft vertical spacing — a planning
// aid, never a weather brief.
import { greatCircleNm } from "../geo.js";

export const LEVELS_HPA = [1000, 950, 900, 850, 800, 700, 600, 500, 400];
export const M_TO_FT = 3.28084;
export const NO_CEILING = 255;
export const LOW_ICE_TOP_FT = 10000;
export const HIGH_ICE_TOP_FT = 25000;
export const CAT_NAMES = ["VFR", "MVFR", "IFR", "LIFR"];
export const CAT_COLORS = ["#3ddc97", "#5b8def", "#e65a5a", "#d65be0"];
const FREEZING_PRECIP_CODES = new Set([56, 57, 66, 67]);

/** Hourly variable names to request. */
export function hourlyVariables() {
  const v = ["temperature_2m", "relative_humidity_2m", "visibility", "precipitation", "weather_code", "cape"];
  for (const p of LEVELS_HPA) v.push(`temperature_${p}hPa`, `cloud_cover_${p}hPa`, `geopotential_height_${p}hPa`);
  return v;
}

/**
 * One time step at one point.
 * @param {{elevM:number, t2mC:number|null, rh2m:number|null, visM:number|null, precipMm:number|null,
 *          codes:number[], cape:number|null, levels:{tC:number|null, cc:number|null, gphM:number|null}[]}} i
 *   `levels` run from the lowest (highest pressure) up.
 * @returns {{lice:number, hice:number, ceil:number, vis:number, prec:number, thun:number, tF:number|null}}
 *   lice/hice 0 none · 1 possible · 2 likely; ceil in hundreds of ft AGL (255 = none below ~FL240);
 *   vis in tenths of a statute mile (max 100); prec in tenths of mm/h; thun 0/1/2; tF °F.
 */
export function deriveStep(i) {
  const elev = i.elevM ?? 0;
  let lice = 0;
  let hice = 0;
  let ceilFt = null;

  for (const lv of i.levels) {
    if (lv.gphM == null || lv.tC == null || lv.cc == null) continue;
    if (lv.gphM < elev + 30) continue; // level is underground
    const mslFt = lv.gphM * M_TO_FT;
    if (ceilFt == null && lv.cc >= 50) ceilFt = (lv.gphM - elev) * M_TO_FT;
    if (lv.tC <= 0 && lv.tC >= -20 && lv.cc >= 40) {
      const sev = lv.cc >= 80 && lv.tC <= -2 && lv.tC >= -15 ? 2 : 1;
      if (mslFt <= LOW_ICE_TOP_FT) lice = Math.max(lice, sev);
      else if (mslFt <= HIGH_ICE_TOP_FT) hice = Math.max(hice, sev);
    }
  }
  if ((i.codes || []).some((c) => FREEZING_PRECIP_CODES.has(c))) lice = 2;

  const visTenths = i.visM == null ? null : Math.min(100, Math.round((i.visM / 1609.34) * 10));
  // radiation fog the coarse levels can't see
  if (i.rh2m != null && i.rh2m >= 97 && i.visM != null && i.visM < 1600) ceilFt = Math.min(ceilFt ?? 1e9, 200);

  const prec = i.precipMm == null ? 0 : Math.min(255, Math.round(i.precipMm * 10));
  const tsCode = (i.codes || []).some((c) => c >= 95);
  const thun = tsCode || ((i.cape ?? 0) >= 1000 && (i.precipMm ?? 0) >= 0.2) ? 2 : (i.cape ?? 0) >= 500 && (i.precipMm ?? 0) > 0 ? 1 : 0;

  return {
    lice,
    hice,
    ceil: ceilFt == null ? NO_CEILING : Math.min(250, Math.max(1, Math.round(ceilFt / 100))),
    vis: visTenths == null ? 100 : visTenths,
    prec,
    thun,
    tF: i.t2mC == null ? null : Math.round((i.t2mC * 9) / 5 + 32),
  };
}

/** 0 VFR · 1 MVFR · 2 IFR · 3 LIFR from ceiling (hundreds ft, 255 = none) and visibility (tenths of SM). */
export function flightCategory(ceilHundreds, visTenths) {
  const ceil = ceilHundreds >= NO_CEILING ? Infinity : ceilHundreds * 100;
  const vis = visTenths / 10;
  if (ceil < 500 || vis < 1) return 3;
  if (ceil < 1000 || vis < 3) return 2;
  if (ceil <= 3000 || vis <= 5) return 1;
  return 0;
}

export const ICE_LABELS = ["none", "possible", "likely"];
export const THUN_LABELS = ["none", "possible", "likely"];
export function ceilingText(c) {
  return c >= NO_CEILING ? "none" : `${(c * 100).toLocaleString("en-US")} ft`;
}
export function visText(tenths) {
  return tenths >= 100 ? "10+ SM" : `${(tenths / 10).toFixed(tenths < 30 ? 1 : 0).replace(/\.0$/, "")} SM`;
}
export function precipText(tenthsMmH) {
  const mm = tenthsMmH / 10;
  return mm < 0.1 ? "none" : mm < 2.5 ? "light" : mm < 7.6 ? "moderate" : "heavy";
}

// ---- grid ----

/**
 * Regular lat/lon grid covering `rangeNm` around every origin. `cov[k]` is 1
 * for cells inside some origin's circle (only those are fetched); k = row *
 * nlon + col, row 0 = southernmost.
 */
export function makeGrid(origins, rangeNm, step = 1) {
  const pad = rangeNm / 60;
  const south = Math.min(...origins.map((o) => o.lat)) - pad;
  const north = Math.max(...origins.map((o) => o.lat)) + pad;
  const wide = (o) => pad / Math.max(0.2, Math.cos((o.lat * Math.PI) / 180));
  const west = Math.min(...origins.map((o) => o.lon - wide(o)));
  const east = Math.max(...origins.map((o) => o.lon + wide(o)));
  const lat0 = Math.floor(south / step) * step;
  const lon0 = Math.floor(west / step) * step;
  const nlat = Math.ceil((north - lat0) / step) + 1;
  const nlon = Math.ceil((east - lon0) / step) + 1;
  const cov = new Array(nlat * nlon).fill(0);
  for (let r = 0; r < nlat; r++) {
    for (let c = 0; c < nlon; c++) {
      const p = { lat: lat0 + r * step, lon: lon0 + c * step };
      if (origins.some((o) => greatCircleNm(o, p) <= rangeNm)) cov[r * nlon + c] = 1;
    }
  }
  return { lat0, lon0, step, nlat, nlon, cov };
}

export const gridPoint = (g, k) => ({ lat: g.lat0 + Math.floor(k / g.nlon) * g.step, lon: g.lon0 + (k % g.nlon) * g.step });

/** Indices of the 3-hourly UTC steps (00,03,…,21Z) in an hourly `time` array. */
export function stepIndices(times) {
  const out = [];
  times.forEach((t, i) => {
    if (Number(t.slice(11, 13)) % 3 === 0) out.push(i);
  });
  return out;
}

const maxOver = (arr, a, b) => {
  let m = null;
  for (let j = Math.max(0, a); j <= Math.min((arr?.length ?? 0) - 1, b); j++) if (arr[j] != null && (m == null || arr[j] > m)) m = arr[j];
  return m;
};

/** Open-Meteo location object -> per-step arrays. */
export function deriveSeries(loc, idxs) {
  const h = loc.hourly || {};
  const out = { lice: [], hice: [], ceil: [], vis: [], prec: [], thun: [], tF: [] };
  for (const i of idxs) {
    const codes = [h.weather_code?.[i - 1], h.weather_code?.[i], h.weather_code?.[i + 1]].filter((c) => c != null);
    const s = deriveStep({
      elevM: loc.elevation ?? 0,
      t2mC: h.temperature_2m?.[i] ?? null,
      rh2m: h.relative_humidity_2m?.[i] ?? null,
      visM: h.visibility?.[i] ?? null,
      precipMm: maxOver(h.precipitation, i - 1, i + 1),
      codes,
      cape: maxOver(h.cape, i - 1, i + 1),
      levels: LEVELS_HPA.map((p) => ({ tC: h[`temperature_${p}hPa`]?.[i] ?? null, cc: h[`cloud_cover_${p}hPa`]?.[i] ?? null, gphM: h[`geopotential_height_${p}hPa`]?.[i] ?? null })),
    });
    for (const k of Object.keys(out)) out[k].push(s[k]);
  }
  return out;
}

export const GRID_LAYERS = ["lice", "hice", "ceil", "vis", "prec", "thun"];

/**
 * Assemble the published files.
 * @param {object} grid  makeGrid() result
 * @param {Map<number, object>} gridLocs  cell index -> Open-Meteo location
 * @param {Map<string, object>} fieldLocs field code -> Open-Meteo location
 * @param {string[]} times  hourly `time` array (UTC, "YYYY-MM-DDTHH:MM")
 */
export function buildWxFiles({ grid, gridLocs, fieldLocs, times, model, generatedAt }) {
  const idxs = stepIndices(times);
  const steps = idxs.map((i) => `${times[i].slice(0, 16)}Z`);
  const cells = grid.nlat * grid.nlon;
  const series = new Map();
  for (const [k, loc] of gridLocs) series.set(k, deriveSeries(loc, idxs));

  // one file per UTC date; each layer is [step][cell]
  const dates = [...new Set(steps.map((s) => s.slice(0, 10)))];
  const days = {};
  for (const date of dates) {
    const stepIdx = steps.map((s, n) => (s.startsWith(date) ? n : -1)).filter((n) => n >= 0);
    const layers = {};
    for (const layer of GRID_LAYERS) {
      const fill = layer === "ceil" ? NO_CEILING : layer === "vis" ? 100 : 0;
      layers[layer] = stepIdx.map((n) => {
        const arr = new Array(cells).fill(fill);
        for (const [k, s] of series) arr[k] = s[layer][n];
        return arr;
      });
    }
    days[date] = { date, steps: stepIdx.map((n) => steps[n]), layers };
  }

  const fields = {};
  for (const [code, loc] of fieldLocs) fields[code] = deriveSeries(loc, idxs);

  return {
    index: {
      generatedAt,
      model,
      steps,
      grid: { lat0: grid.lat0, lon0: grid.lon0, step: grid.step, nlat: grid.nlat, nlon: grid.nlon, cov: grid.cov.join("") },
      dates,
    },
    days,
    fields: { generatedAt, steps, fields },
  };
}
