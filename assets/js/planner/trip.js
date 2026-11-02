// The trip builder's arithmetic: legs from the base through the chosen stops,
// range flags, per diem estimate and a route string for ForeFlight. Pure.
import { greatCircleNm, flightMinutes } from "../geo.js";
import { perDiemFor } from "./fields.js";
import { sunTimes, fieldTimeZone, zonedInstant, wallClock, minutesOfDay, clock } from "./sun.js";
import { hoursForDay, fmtMin } from "./hours.js";

/**
 * The URL form of the stops: "KOKC*@202611070900,KTUL" — * marks a RON stop and
 * @YYYYMMDDHHmm the takeoff time (field-local) of the leg that ends at that stop.
 */
const compact = (dep) => dep.replace(/[-:T]/g, "");
const expand = (c) => `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}T${c.slice(8, 10)}:${c.slice(10, 12)}`;
export const encodeTrip = (stops) => stops.map((s) => `${s.code}${s.ron ? "*" : ""}${s.dep ? `@${compact(s.dep)}` : ""}`).join(",");
export const decodeTrip = (text) =>
  String(text || "")
    .split(",")
    .map((t) => /^([A-Z0-9]{2,5})(\*)?(?:@(\d{12}))?$/.exec(t.trim()))
    .filter(Boolean)
    .map((m) => ({ code: m[1], ron: Boolean(m[2]), ...(m[3] ? { dep: expand(m[3]) } : {}) }));
export const encodeDep = (dep) => (dep ? compact(dep) : "");
export const decodeDep = (c) => (/^\d{12}$/.test(c || "") ? expand(c) : "");

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
  const rates = nights.map((s) => ({ code: s.field.code, pd: perDiemFor(s.field, s.date || tripDate) }));
  const missing = rates.filter((r) => !r.pd).map((r) => r.code);
  const lodging = rates.reduce((sum, r) => sum + (r.pd?.lodging || 0), 0);
  const days = nights.length + 1;
  let meals = 0;
  for (let d = 0; d < days; d++) {
    const rate = rates[Math.min(d, rates.length - 1)].pd?.meals || 0;
    meals += d === 0 || d === days - 1 ? rate * 0.75 : rate;
  }
  return { nights: nights.length, days, lodging, meals: Math.round(meals * 100) / 100, total: Math.round((lodging + meals) * 100) / 100, missing };
}

const TURNAROUND_MIN = 60;
const addDay = (dayKey) => {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
const ceil5 = (instant) => new Date(Math.ceil(instant.getTime() / 300000) * 300000);

export const originTimeZone = (origin) => origin.tz || fieldTimeZone(undefined, origin.lat, origin.lon);
export const stopTimeZone = (f) => fieldTimeZone(f.state, f.lat, f.lon);

/**
 * Times for every leg. Leg 1 takes off on the trip date (time defaults to
 * 09:00); each later leg defaults to an hour after the previous one lands, or
 * the next morning at 09:00 after a RON; any leg can be set explicitly
 * (`dep`, field-local "YYYY-MM-DDTHH:mm"; for leg 1 only the time is used —
 * the date is the trip date).
 * @param {{origin, stops:{field, ron:boolean, dep?:string}[], legs:object[], tripDate:string, returnDep?:string}} i
 *   `legs` is tripLegs().legs
 */
export function scheduleTrip({ origin, stops, legs, tripDate, returnDep }) {
  const out = [];
  let prevEta = null;
  let prevRon = false;
  legs.forEach((leg, i) => {
    const isReturn = i >= stops.length;
    const fromTz = i === 0 ? originTimeZone(origin) : stopTimeZone(stops[i - 1].field);
    const toTz = isReturn ? originTimeZone(origin) : stopTimeZone(stops[i].field);
    const explicit = isReturn ? returnDep : stops[i].dep;
    let dep;
    if (i === 0) dep = zonedInstant(tripDate, explicit ? explicit.slice(11, 16) : "09:00", fromTz);
    else if (explicit) dep = zonedInstant(explicit.slice(0, 10), explicit.slice(11, 16), fromTz);
    else if (prevRon) dep = zonedInstant(addDay(wallClock(prevEta, fromTz).date), "09:00", fromTz);
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
      ron: !isReturn && stops[i].ron,
    });
    prevEta = eta;
    prevRon = !isReturn && stops[i].ron;
  });
  return out;
}

/** Things to know about landing at the leg's destination at its ETA: night, closed FBO. Skips the base. */
export function legFlags(leg) {
  const f = leg.toField;
  const flags = [];
  if (leg.overlapsPrevious) flags.push({ level: "bad", text: "takes off before the previous leg lands" });
  if (!f || !Number.isFinite(f.lat)) return flags;
  const tz = leg.toTz;
  const day = leg.etaLocal.date;
  const sun = sunTimes(day, f.lat, f.lon);
  if (sun) {
    if (leg.eta > sun.sunset) flags.push({ level: "warn", text: `lands after sunset (${clock(sun.sunset, tz)}) — night` });
    else if (leg.eta < sun.sunrise) flags.push({ level: "warn", text: `lands before sunrise (${clock(sun.sunrise, tz)}) — night` });
  }
  const h = hoursForDay(f.attendance, day, tz);
  const at = minutesOfDay(leg.eta, tz);
  if (h.kind === "closed") flags.push({ level: "warn", text: "FBO closed that day per the FAA attendance text" });
  else if (h.kind === "open" && (at < h.openMin || at > h.closeMin)) flags.push({ level: "warn", text: `FBO closed at arrival (${fmtMin(h.openMin)} – ${fmtMin(h.closeMin)})` });
  return flags;
}
