// Ceiling timeline for one leg: the forecast ceiling at the departure and the
// destination field from the leg's takeoff time onward, shown only when the
// leg runs into instrument conditions. Pure: the caller hands in a
// `forecastAt(code, instant)` like the weather controller's.
import { flightCategory, ceilingText, CAT_NAMES, CAT_COLORS, NO_CEILING } from "./wx-model.js";
import { clock, zoneAbbr } from "./sun.js";

export const WINDOW_HOURS = 12; // how far past takeoff the timeline reaches
export const SAMPLE_MIN = 30;
const MAX_FT = 5000; // taller ceilings are drawn full height
const IFR = 2; // flightCategory() value: 2 IFR, 3 LIFR

/**
 * Forecast samples at `code` every SAMPLE_MIN from `start`. Samples with no
 * forecast (past the end of the published run) are null; the whole result is
 * null when there is no forecast for this field at all.
 * @returns {({t:Date, cat:number, ceilFt:number|null, f:object}|null)[]|null}
 */
export function ceilingSeries(forecastAt, code, start, hours = WINDOW_HOURS) {
  const out = [];
  for (let m = 0; m < hours * 60; m += SAMPLE_MIN) {
    const t = new Date(start.getTime() + m * 60000);
    const f = forecastAt(code, t);
    out.push(f ? { t, cat: flightCategory(f.ceil, f.vis), ceilFt: f.ceil >= NO_CEILING ? null : f.ceil * 100, f } : null);
  }
  return out.some(Boolean) ? out : null;
}

/** The sample in force at `instant` (the latest one at or before it). */
export const sampleAt = (series, instant) => series.filter((s) => s && s.t <= instant).at(-1) || null;

/**
 * Does this leg run into worse than VFR? Yes when either end is at `minCat`
 * (default IFR; pass 1 to include marginal VFR) or lower at any time from
 * takeoff to 90 minutes after landing.
 */
export function legIsInstrument(dep, to, depAt, etaAt, minCat = IFR) {
  const until = new Date(etaAt.getTime() + 90 * 60000);
  return [dep, to].some((series) => series?.some((s) => s && s.t >= depAt && s.t <= until && s.cat >= minCat));
}

/** The worst sample (highest category, then lowest ceiling) in the leg's window, or null when it is all VFR. */
export function worstSample(series, depAt, etaAt, minCat = 1) {
  const until = new Date(etaAt.getTime() + 90 * 60000);
  const hits = (series || []).filter((s) => s && s.t >= depAt && s.t <= until && s.cat >= minCat);
  return hits.sort((a, b) => b.cat - a.cat || (a.ceilFt ?? Infinity) - (b.ceilFt ?? Infinity))[0] || null;
}

/** "IFR at landing · lifts to VFR by 1:00 PM CDT (ceiling 3,500 ft)" — the one-line read of a series. */
export function summarize(series, etaAt, tz) {
  const here = sampleAt(series, etaAt);
  if (!here) return "no forecast at landing time";
  const label = `${CAT_NAMES[here.cat]} at landing (ceiling ${ceilingText(here.f.ceil)})`;
  const later = series.find((s) => s && s.t > etaAt && (here.cat >= IFR ? s.cat < IFR : s.cat >= IFR));
  if (!later) return here.cat >= IFR ? `${label} · stays instrument through the forecast window` : label;
  const at = `${clock(later.t, tz)} ${zoneAbbr(later.t, tz)}`;
  return here.cat >= IFR ? `${label} · lifts to ${CAT_NAMES[later.cat]} by ${at} (ceiling ${ceilingText(later.f.ceil)})` : `${label} · drops to ${CAT_NAMES[later.cat]} by ${at} (ceiling ${ceilingText(later.f.ceil)})`;
}

const W = 300;
const STRIP_H = 38;

/**
 * Inline SVG: one strip per field, a bar per half hour (height = ceiling up to
 * 5,000 ft, colour = flight category), takeoff at the left edge, landing marked,
 * 1,000 / 3,000 ft guide lines, hour ticks in the destination's local time.
 */
export function timelineSvg({ rows, depAt, etaAt, tz, hours = WINDOW_HOURS }) {
  const n = hours * 60 / SAMPLE_MIN;
  const bw = W / n;
  const stripTop = (r) => 12 + r * (STRIP_H + 16);
  const bottom = stripTop(rows.length) - 4;
  const x = (instant) => Math.max(0, Math.min(W, ((instant - depAt) / (hours * 3600000)) * W));
  const y = (r, ft) => stripTop(r) + STRIP_H * (1 - Math.min(ft, MAX_FT) / MAX_FT);
  let g = "";
  rows.forEach((row, r) => {
    g += `<text x="${W}" y="${stripTop(r) - 3}" class="tl-label" text-anchor="end">${row.label}</text>`;
    g += `<rect x="0" y="${stripTop(r)}" width="${W}" height="${STRIP_H}" class="tl-bg"/>`;
    row.series.forEach((s, k) => {
      if (!s) return;
      const h = s.ceilFt == null ? STRIP_H : Math.max(2, STRIP_H * (Math.min(s.ceilFt, MAX_FT) / MAX_FT));
      g += `<rect x="${(k * bw).toFixed(1)}" y="${(stripTop(r) + STRIP_H - h).toFixed(1)}" width="${(bw + 0.4).toFixed(1)}" height="${h.toFixed(1)}" fill="${CAT_COLORS[s.cat]}" opacity="${s.ceilFt == null ? 0.3 : 0.85}"/>`;
    });
    for (const ft of [1000, 3000]) g += `<line x1="0" x2="${W}" y1="${y(r, ft).toFixed(1)}" y2="${y(r, ft).toFixed(1)}" class="tl-guide"/><text x="${W - 1}" y="${(y(r, ft) - 1.5).toFixed(1)}" class="tl-guide-t" text-anchor="end">${ft / 1000}k</text>`;
  });
  for (let h = 0; h <= hours; h += 3) {
    const t = new Date(depAt.getTime() + h * 3600000);
    g += `<line x1="${x(t)}" x2="${x(t)}" y1="${stripTop(0)}" y2="${bottom}" class="tl-tick"/><text x="${x(t)}" y="${bottom + 10}" class="tl-label" text-anchor="${h === 0 ? "start" : h === hours ? "end" : "middle"}">${clock(t, tz).replace(":00", "").replace(" ", "")}</text>`;
  }
  const lx = x(etaAt);
  g += `<line x1="${lx}" x2="${lx}" y1="${stripTop(0) - 8}" y2="${bottom}" class="tl-land"/><text x="${Math.min(W - 24, lx + 2)}" y="${stripTop(0) - 3}" class="tl-land-t">land</text>`;
  const alt = rows.map((row) => `${row.label}: ${summarize(row.series, etaAt, tz)}`).join("; ");
  return `<svg class="tl-svg" viewBox="0 0 ${W} ${bottom + 14}" role="img" aria-label="Ceiling timeline from takeoff. ${alt.replace(/"/g, "'")}">${g}</svg>`;
}

/**
 * "Alternate may be required": the lowest forecast ceiling at the arrival field
 * within `windowMin` minutes either side of the ETA, when it is below `belowFt`.
 * @returns {{ceilFt:number, f:object}|null}
 */
export function alternateCheck(forecastAt, code, eta, belowFt = 2000, windowMin = 60) {
  let worst = null;
  for (let m = -windowMin; m <= windowMin; m += 30) {
    const f = forecastAt(code, new Date(eta.getTime() + m * 60000));
    if (!f || f.ceil >= NO_CEILING) continue;
    const ceilFt = f.ceil * 100;
    if (ceilFt < belowFt && (!worst || ceilFt < worst.ceilFt)) worst = { ceilFt, f };
  }
  return worst;
}
