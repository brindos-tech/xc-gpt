// Sunrise / sunset / civil twilight (the "Almanac for Computers" algorithm,
// good to about a minute) and the field's local time zone. Dependency-free;
// used for "is the FBO open, and is it daylight" on the field sheet.

const rad = Math.PI / 180;
const deg = 180 / Math.PI;
const mod = (a, n) => ((a % n) + n) % n;

function ut(y, m, d, lat, lon, zenith, rising) {
  const N = Math.floor((275 * m) / 9) - Math.floor((m + 9) / 12) * (1 + Math.floor((y - 4 * Math.floor(y / 4) + 2) / 3)) + d - 30;
  const lngHour = lon / 15;
  const t = N + ((rising ? 6 : 18) - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  const L = mod(M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634, 360);
  let RA = mod(Math.atan(0.91764 * Math.tan(L * rad)) * deg, 360);
  RA = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15;
  const sinDec = 0.39782 * Math.sin(L * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(zenith * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  if (cosH > 1 || cosH < -1) return null; // sun never rises / never sets that day
  const H = (rising ? 360 - Math.acos(cosH) * deg : Math.acos(cosH) * deg) / 15;
  return mod(H + RA - 0.06571 * t - 6.622 - lngHour, 24);
}

/**
 * Sun events for a calendar day at a place, as Dates (instants). `dayKey` is
 * "YYYY-MM-DD" as the people at the field see it. Returns null at polar extremes.
 */
export function sunTimes(dayKey, lat, lon) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const events = {};
  for (const [key, zenith, rising] of [["sunrise", 90.833, true], ["sunset", 90.833, false], ["dawn", 96, true], ["dusk", 96, false]]) {
    const h = ut(y, m, d, lat, lon, zenith, rising);
    if (h == null) return null;
    events[key] = h;
  }
  // West of Greenwich the evening events fall on the next UTC day
  const base = Date.UTC(y, m - 1, d);
  const at = (h, lateDay) => new Date(base + (h + (lateDay ? 24 : 0)) * 3600000);
  return {
    dawn: at(events.dawn, false),
    sunrise: at(events.sunrise, false),
    sunset: at(events.sunset, events.sunset < events.sunrise),
    dusk: at(events.dusk, events.dusk < events.dawn),
  };
}

// ---- time zone ----
const STATE_TZ = {
  AL: "America/Chicago", AR: "America/Chicago", AZ: "America/Phoenix", CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York",
  DC: "America/New_York", DE: "America/New_York", FL: "America/New_York", GA: "America/New_York", IA: "America/Chicago", ID: "America/Boise",
  IL: "America/Chicago", IN: "America/Indiana/Indianapolis", KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", MA: "America/New_York",
  MD: "America/New_York", ME: "America/New_York", MI: "America/Detroit", MN: "America/Chicago", MO: "America/Chicago", MS: "America/Chicago",
  MT: "America/Denver", NC: "America/New_York", ND: "America/Chicago", NE: "America/Chicago", NH: "America/New_York", NJ: "America/New_York",
  NM: "America/Denver", NV: "America/Los_Angeles", NY: "America/New_York", OH: "America/New_York", OK: "America/Chicago", OR: "America/Los_Angeles",
  PA: "America/New_York", RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VA: "America/New_York", VT: "America/New_York", WA: "America/Los_Angeles", WI: "America/Chicago", WV: "America/New_York",
  WY: "America/Denver",
};

/** IANA zone for a field: its state's zone, with the split states decided by longitude/latitude. */
export function fieldTimeZone(state, lat, lon) {
  const c = "America/Chicago";
  const m = "America/Denver";
  switch (state) {
    case "TX": return lon < -104.5 ? m : c;
    case "KS": return lon < -101.5 ? m : c;
    case "NE": return lon < -101 ? m : c;
    case "SD": return lon < -100.4 ? m : c;
    case "ND": return lon < -101 ? m : c;
    case "FL": return lon < -85 ? c : "America/New_York";
    case "KY": return lon < -85.4 ? c : "America/New_York";
    case "TN": return lon > -85.4 ? "America/New_York" : c;
    case "ID": return lat > 45.4 ? "America/Los_Angeles" : "America/Boise";
    case "OR": return lon > -117.2 && lat < 44.5 ? m : "America/Los_Angeles";
    case "NV": return lon > -114.5 && lat > 40.5 ? m : "America/Los_Angeles";
    case "IN": return lon < -86.7 && (lat > 41.4 || lat < 38.3) ? c : "America/New_York";
    case "MI": return lon < -87.2 && lat > 45.3 ? c : "America/Detroit";
    default: return STATE_TZ[state] || (lon < -114 ? "America/Los_Angeles" : lon < -101 ? m : lon < -86 ? c : "America/New_York");
  }
}

/** Offset of `tz` from UTC in minutes at an instant (negative for the US). */
export function tzOffsetMin(tz, instant) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(instant);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Math.round((Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - instant.getTime()) / 60000);
}

/** "5:48 PM" in a zone. */
export const clock = (instant, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(instant);
/** "CDT" for a zone at an instant. */
export const zoneAbbr = (instant, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(instant).find((p) => p.type === "timeZoneName")?.value || "";
/** Minutes after local midnight of an instant in a zone. */
export function minutesOfDay(instant, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "numeric", minute: "numeric" }).formatToParts(instant);
  return Number(parts.find((p) => p.type === "hour").value) * 60 + Number(parts.find((p) => p.type === "minute").value);
}
