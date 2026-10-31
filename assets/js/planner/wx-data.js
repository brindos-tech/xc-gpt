// Loads and samples the forecast grid published by scripts/fetch-wx.js
// (data/generated/wx/). Per-UTC-date files load on demand.
import { toDateKey } from "../format.js";
import { NO_CEILING } from "./wx-model.js";

export const GRID_LAYER_KEYS = ["lice", "hice", "ceil", "vis", "prec", "thun"];

export function createWxData(loadJson) {
  let index = null;
  let cov = null;
  let fieldFile = null;
  let initPromise = null;
  let fieldsPromise = null;
  const dayPromises = new Map();
  const days = new Map();

  function init() {
    initPromise ??= loadJson("generated/wx/index.json")
      .then((d) => {
        index = d;
        cov = Uint8Array.from(d.grid.cov, Number);
        return true;
      })
      .catch(() => false); // no weather published yet: the app just hides the bar
    return initPromise;
  }

  function loadDay(date) {
    if (!dayPromises.has(date)) {
      dayPromises.set(
        date,
        loadJson(`generated/wx/${date}.json`).then((d) => {
          days.set(date, d);
          return d;
        })
      );
    }
    return dayPromises.get(date);
  }

  function loadFields() {
    fieldsPromise ??= loadJson("generated/wx/fields.json")
      .then((d) => (fieldFile = d))
      .catch(() => null);
    return fieldsPromise;
  }

  /** UTC step times (ISO) whose local calendar date is `dateKey`. */
  const stepsForLocalDate = (dateKey) => (index?.steps || []).filter((t) => toDateKey(new Date(t)) === dateKey);

  /** Make sure the files for these steps are in memory. */
  const ensureSteps = (steps) => Promise.all([...new Set(steps.map((s) => s.slice(0, 10)))].map(loadDay));

  /** Grid values [cell] for one layer at one step, or null if not loaded. */
  function layerValues(step, layer) {
    const day = days.get(step.slice(0, 10));
    const n = day?.steps.indexOf(step);
    return day && n >= 0 ? day.layers[layer][n] : null;
  }

  /** Bilinear sample over covered cells; `nearest` for categorical values. null outside coverage. */
  function sample(values, lat, lon, nearest = false) {
    const g = index.grid;
    const gy = (lat - g.lat0) / g.step;
    const gx = (lon - g.lon0) / g.step;
    if (gy < -0.5 || gx < -0.5 || gy > g.nlat - 0.5 || gx > g.nlon - 0.5) return null;
    if (nearest) {
      const r = Math.min(g.nlat - 1, Math.max(0, Math.round(gy)));
      const c = Math.min(g.nlon - 1, Math.max(0, Math.round(gx)));
      return cov[r * g.nlon + c] ? values[r * g.nlon + c] : null;
    }
    const r0 = Math.min(g.nlat - 2, Math.max(0, Math.floor(gy)));
    const c0 = Math.min(g.nlon - 2, Math.max(0, Math.floor(gx)));
    const fy = Math.min(1, Math.max(0, gy - r0));
    const fx = Math.min(1, Math.max(0, gx - c0));
    let sum = 0;
    let wsum = 0;
    for (const [dr, dc, w] of [[0, 0, (1 - fy) * (1 - fx)], [0, 1, (1 - fy) * fx], [1, 0, fy * (1 - fx)], [1, 1, fy * fx]]) {
      const k = (r0 + dr) * g.nlon + c0 + dc;
      if (!cov[k] || w <= 0) continue;
      sum += values[k] * w;
      wsum += w;
    }
    return wsum ? sum / wsum : null;
  }

  /** All layers at a point and step (ceiling "none" survives as NO_CEILING). */
  function pointAt(step, lat, lon) {
    const out = {};
    for (const layer of GRID_LAYER_KEYS) {
      const vals = layerValues(step, layer);
      if (!vals) return null;
      const v = sample(vals, lat, lon, layer === "ceil");
      if (v == null) return null;
      out[layer] = layer === "ceil" ? v : Math.round(v);
    }
    // ceiling is sampled nearest-cell; round the rest after interpolating
    return out;
  }

  /** One field's series at a step, from the per-field file. */
  function fieldAt(code, step) {
    const f = fieldFile?.fields?.[code];
    const n = fieldFile?.steps?.indexOf(step);
    if (!f || n == null || n < 0) return null;
    return { lice: f.lice[n], hice: f.hice[n], ceil: f.ceil[n], vis: f.vis[n], prec: f.prec[n], thun: f.thun[n], tF: f.tF[n] };
  }

  return {
    init,
    loadFields,
    loadDay,
    ensureSteps,
    stepsForLocalDate,
    layerValues,
    sample,
    pointAt,
    fieldAt,
    get index() {
      return index;
    },
    get hasFields() {
      return Boolean(fieldFile);
    },
    NO_CEILING,
  };
}
