// The trip builder's arithmetic: legs from the base through the chosen stops,
// range flags, per diem estimate and a route string for ForeFlight. Pure.
import { greatCircleNm, flightMinutes } from "../geo.js";
import { perDiemFor } from "./fields.js";
import { sunTimes, fieldTimeZone, zonedInstant, wallClock, minutesOfDay, clock } from "./sun.js";
import { hoursForDay, fmtMin } from "./hours.js";

/**
 * The URL form of the stops: "KOKC@202611070900,KTUL" — @YYYYMMDDHHmm is the takeoff time
 * (field-local) of the leg that ends at that stop.
 */
const compact = (dep) => dep.replace(/[-:T]/g, "");
const expand = (c) => `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T${c.slice(8, 10)}:${c.slice(10, 12)}`;

/** A real calendar date "YYYY-MM-DD" (2026-02-30 is not one). */
export function isValidDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || "");
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
/** A real takeoff time "YYYY-MM-DDTHH:mm". */
export const isValidDep = (str) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str || "") && isValidDate(str.slice(0, 10)) && Number(str.slice(11, 13)) < 24 && Number(str.slice(14, 16)) < 60;

// The URL no longer carries a RON marker (RON comes from the takeoff dates); old links with a "*" still open.
export const encodeTrip = (stops) => stops.map((s) => `${s.code}${s.dep ? `@${compact(s.dep)}` : ""}`).join(",");
export const decodeTrip = (text) =>
  String(text || "")
    .split(",")
    .map((t) => /^([A-Z0-9]{2,5})(\*)?(?:@(\d{12}))?$/.exec(t.trim()))
    .filter(Boolean)
    .map((m) => ({ code: m[1], ron: false, ...(m[3] && isValidDep(expand(m[3])) ? { dep: expand(m[3]) } : {}) }));
export const encodeDep = (dep) => (dep ? compact(dep) : "");
export const decodeDep = (c) => (/^\d{12}$/.test(c || "") && isValidDep(expand(c)) ? expand(c) : "");

/**
 * Legs: base -> stop 1 -> … -> last stop (-> base when `roundTrip`).
 * @param {{lat:number, lon:number, icao:string}} origin
 * @param {object[]} stops fields in order (need code, lat, lon)
 */
export function tripLegs(origin, stops, config, roundTrip = true) {
  const points = [{ code: origin.icao, lat: origin.lat, lon: origin.lon }, ...stops.map((f) => ({ code: f.code, lat: f.lat, lon: f.lon }))];
  if (roundTrip && stops.length) points.push(points[0]);
  const legs = [];
  for (let i = 1; i < points.length; i++) {
    const nm = greatCircleNm(points[i - 1], points[i]);
    legs.push({ from: points[i - 1].code, to: points[i].code, nm, mins: flightMinutes(nm, config.aircraft.cruiseKts), overRange: nm > config.aircraft.legRangeNm });
  }
  return { legs, totalNm: legs.reduce((s, l) => s + l.nm, 0), totalMins: legs.reduce((s, l) => s + l.mins, 0) };
}

/** "KEND KOKC KTUL KEND" — pastes straight into ForeFlight's route box. */
export const routeString = (origin, stops, roundTrip = true) => [origin.icao, ...stops.map((f) => f.code), ...(roundTrip && stops.length ? [origin.icao] : [])].join(" ");

/**
 * Per diem estimate. Each RON stop is a night of lodging at that field's rate.
 * Meals and incidentals: one rate per day (the field where that night is
 * spent; the last day uses the last RON stop), with the first and last day at
 * 75% as the GSA rules do. A trip with no RON has no per diem here.
 * @param {object[]} stops [{ field, ron, date? }] — `date` is the night's date (its month sets the lodging rate); default the trip date
 */
export function tripPerDiem(stops, tripDate) {
  const nights = stops.filter((s) => s.ron);
  if (!nights.length) return { nights: 0, days: 1, lodging: 0, meals: 0, total: 0, missing: [] };
  // one entry per night (a stop with `nights: 2` is two nights at that field's rate)
  const rates = nights.flatMap((s) => Array.from({ length: Math.max(1, s.nights || 1) }, () => ({ code: s.field.code, pd: perDiemFor(s.field, s.date || tripDate) })));
  const missing = [...new Set(rates.filter((r) => !r.pd).map((r) => r.code))];
  const lodging = rates.reduce((sum, r) => sum + (r.pd?.lodging || 0), 0);
  const days = rates.length + 1;
  let meals = 0;
  for (let d = 0; d < days; d++) {
    const rate = rates[Math.min(d, rates.length - 1)].pd?.meals || 0;
    meals += d === 0 || d === days - 1 ? rate * 0.75 : rate;
  }
  return { nights: rates.length, days, lodging, meals: Math.round(meals * 100) / 100, total: Math.round((lodging + meals) * 100) / 100, missing };
}

const TURNAROUND_MIN = 60;
/** Whole calendar days from one "YYYY-MM-DD" to another. */
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const ceil5 = (instant) => new Date(Math.ceil(instant.getTime() / 300000) * 300000);

export const originTimeZone = (origin) => origin.tz || fieldTimeZone(undefined, origin.lat, origin.lon);
export const stopTimeZone = (f) => fieldTimeZone(f.state, f.lat, f.lon);

/**
 * Times for every leg. Leg 1 takes off on the trip date (time defaults to
 * 09:00); each later leg defaults to an hour after the previous one lands; any
 * leg can be set explicitly. A leg that takes off on a later day than the
 * previous one landed makes that stop a RON (`ron`, `nights` on the earlier leg)
 * (`dep`, field-local "YYYY-MM-DDTHH:mm"; for leg 1 only the time is used —
 * the date is the trip date).
 * @param {{origin, stops:{field, ron:boolean, dep?:string}[], legs:object[], tripDate:string, returnDep?:string}} i
 *   `legs` is tripLegs().legs
 */
export function scheduleTrip({ origin, stops, legs, tripDate, returnDep }) {
  const out = [];
  let prevEta = null;
  legs.forEach((leg, i) => {
    const isReturn = i >= stops.length;
    const fromTz = i === 0 ? originTimeZone(origin) : stopTimeZone(stops[i - 1].field);
    const toTz = isReturn ? originTimeZone(origin) : stopTimeZone(stops[i].field);
    const explicit = isReturn ? returnDep : stops[i].dep;
    let dep;
    if (i === 0) dep = zonedInstant(tripDate, explicit ? explicit.slice(11, 16) : "09:00", fromTz);
    else if (explicit) dep = zonedInstant(explicit.slice(0, 10), explicit.slice(11, 16), fromTz);
    else dep = ceil5(new Date(prevEta.getTime() + TURNAROUND_MIN * 60000));
    const eta = new Date(dep.getTime() + leg.mins * 60000);
    out.push({
      i,
      isReturn,
      from: leg.from,
      to: leg.to,
      dep,
      eta,
      fromTz,
      toTz,
      depLocal: wallClock(dep, fromTz),
      etaLocal: wallClock(eta, toTz),
      explicit: Boolean(explicit),
      overlapsPrevious: prevEta ? dep < prevEta : false,
      toField: isReturn ? null : stops[i].field,
      ron: false,
      nights: 0,
    });
    prevEta = eta;
  });
  // A takeoff on a later day than the landing means the night is spent at that
  // field (RON), one night per day in between.
  out.forEach((leg, i) => {
    const next = out[i + 1];
    leg.nights = next && !leg.isReturn ? Math.max(0, daysBetween(leg.etaLocal.date, next.depLocal.date)) : 0;
    leg.ron = leg.nights > 0;
  });
  return out;
}

/**
 * Things to know about landing at the leg's destination at its ETA: night and a
 * closed FBO. Night is the FAA's: after the end of evening civil twilight (ECT)
 * or before the morning civil twilight (MCT) begins — not sunset/sunrise.
 * Skips the base.
 */
export function legFlags(leg) {
  const f = leg.toField;
  const flags = [];
  if (leg.overlapsPrevious) flags.push({ level: "bad", text: "takes off before the previous leg lands" });
  if (!f || !Number.isFinite(f.lat)) return flags;
  const tz = leg.toTz;
  const day = leg.etaLocal.date;
  const sun = sunTimes(day, f.lat, f.lon);
  if (sun) {
    if (leg.eta > sun.dusk) flags.push({ level: "warn", text: `lands after ECT (${clock(sun.dusk, tz)}) — night` });
    else if (leg.eta < sun.dawn) flags.push({ level: "warn", text: `lands before MCT (${clock(sun.dawn, tz)}) — night` });
  }
  const h = hoursForDay(f.attendance, day, tz);
  const at = minutesOfDay(leg.eta, tz);
  if (h.kind === "closed") flags.push({ level: "warn", text: "FBO closed that day per the FAA attendance text" });
  else if (h.kind === "open" && (at < h.openMin || at > h.closeMin)) flags.push({ level: "warn", text: `FBO closed at arrival (${fmtMin(h.openMin)} – ${fmtMin(h.closeMin)})` });
  return flags;
}
