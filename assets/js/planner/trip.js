// The trip builder's arithmetic: legs from the base through the chosen stops,
// range flags, per diem estimate and a route string for ForeFlight. Pure.
import { greatCircleNm, flightMinutes } from "../geo.js";
import { perDiemFor } from "./fields.js";

/** "KOKC*,KTUL" <-> [{code:"KOKC", ron:true}, {code:"KTUL", ron:false}] (the URL form; * marks a RON stop). */
export const encodeTrip = (stops) => stops.map((s) => `${s.code}${s.ron ? "*" : ""}`).join(",");
export const decodeTrip = (text) =>
  String(text || "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^[A-Z0-9]{2,5}\*?$/.test(t))
    .map((t) => ({ code: t.replace("*", ""), ron: t.endsWith("*") }));

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
 * @param {object[]} stops [{ field, ron }]
 */
export function tripPerDiem(stops, tripDate) {
  const nights = stops.filter((s) => s.ron);
  if (!nights.length) return { nights: 0, days: 1, lodging: 0, meals: 0, total: 0, missing: [] };
  const rates = nights.map((s) => ({ code: s.field.code, pd: perDiemFor(s.field, tripDate) }));
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
