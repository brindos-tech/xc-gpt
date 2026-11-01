// A synthetic forecast in the exact shape scripts/fetch-wx.js publishes, so
// the browser test can exercise the weather UI without calling Open-Meteo.
// Western cells get a low overcast with icing temperatures; the rest is clear.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LEVELS_HPA, makeGrid, gridPoint, buildWxFiles } from "../../assets/js/planner/wx-model.js";

export function writeFakeWx(siteDir, config, factsFile) {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const times = Array.from({ length: 24 * 9 }, (_, h) => new Date(start + h * 3600000).toISOString().slice(0, 16));
  const grid = makeGrid(config.origins, 650);
  const loc = (lat, lon) => {
    const west = lon < -98;
    const hourly = {
      time: times,
      temperature_2m: times.map(() => 12),
      relative_humidity_2m: times.map(() => 60),
      visibility: times.map(() => (west ? 6000 : 24000)),
      precipitation: times.map(() => (west ? 1.2 : 0)),
      weather_code: times.map(() => 3),
      cape: times.map(() => 0),
    };
    for (const p of LEVELS_HPA) {
      hourly[`temperature_${p}hPa`] = times.map(() => 15 - (1000 - p) * 0.06);
      hourly[`cloud_cover_${p}hPa`] = times.map(() => (west && p === 900 ? 95 : west && p === 700 ? 90 : 0));
      hourly[`geopotential_height_${p}hPa`] = times.map(() => 100 + (1000 - p) * 8.7);
    }
    return { elevation: 300, hourly };
  };
  const gridLocs = new Map();
  grid.cov.forEach((c, k) => {
    if (c) gridLocs.set(k, loc(gridPoint(grid, k).lat, gridPoint(grid, k).lon));
  });
  const fieldLocs = new Map(Object.entries(factsFile.facts).filter(([, f]) => Number.isFinite(f.lat)).map(([code, f]) => [code, loc(f.lat, f.lon)]));
  const files = buildWxFiles({ grid, gridLocs, fieldLocs, times, model: "fake", generatedAt: new Date().toISOString() });
  const dir = path.join(siteDir, "data/generated/wx");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.json"), JSON.stringify(files.index));
  writeFileSync(path.join(dir, "fields.json"), JSON.stringify(files.fields));
  for (const [date, day] of Object.entries(files.days)) writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(day));
}

/** A synthetic TFR near Vance, in the shape scripts/fetch-tfr.js publishes. */
export function writeFakeTfr(siteDir) {
  const ring = [[-98.3, 36.1], [-97.5, 36.1], [-97.5, 36.6], [-98.3, 36.6], [-98.3, 36.1]];
  writeFileSync(
    path.join(siteDir, "data/generated/wx/tfr.json"),
    JSON.stringify({ builtAt: new Date().toISOString(), type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { id: "TFR:6/9999", type: "TFR", name: "TFR 6/9999", title: "Test City, OK, Saturday, November 7, 2026 Local", kind: "Hazards", state: "OK", notam: "6/9999", modified: "202611010100" } }] })
  );
}
