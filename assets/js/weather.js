// Shared reading of data/generated/weather.json (a 16-day daily outlook per
// place). Advisory only — not a substitute for a real briefing.
import { weatherCodeLabel, dowShort } from "./format.js";

// Flags a day as a possible icing setup when the low is at/near freezing
// and precip odds are meaningful; a coarse heuristic, not a forecast product.
export const ICING_TEMP_F = 34;
export const ICING_PRECIP_PCT = 40;

const THUNDER_CODES = new Set([95, 96, 99]);

/**
 * The outlook for the given YYYY-MM-DD days, skipping any the forecast
 * doesn't reach. Returns [] when none are covered, so a weekend past the
 * 16-day horizon simply shows no weather rather than a guess.
 */
export function outlookForDays(weather, dateKeys) {
  if (!weather?.dates?.length) return [];
  return dateKeys
    .map((key) => weather.dates.indexOf(key))
    .filter((i) => i >= 0)
    .map((i) => {
      const lo = Math.round(weather.tempMin[i]);
      const precip = weather.precipProbability[i];
      return {
        date: weather.dates[i],
        dow: dowShort(weather.dates[i]),
        hi: Math.round(weather.tempMax[i]),
        lo,
        precip,
        label: weatherCodeLabel(weather.weatherCode[i]),
        thunder: THUNDER_CODES.has(weather.weatherCode[i]),
        icing: weather.tempMin[i] <= ICING_TEMP_F && precip >= ICING_PRECIP_PCT,
      };
    });
}
