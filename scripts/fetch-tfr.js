#!/usr/bin/env node
// Temporary flight restrictions from the FAA's TFR site: polygons from its
// WFS feed plus the type from its list API. Written to
// data/generated/wx/tfr.json (published on the wx-data branch; the page reads
// it from there so it can be fresher than the last deploy).
//
//   node scripts/fetch-tfr.js

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fetchJsonWithRetry } from "./lib/http.js";

const OUT = path.resolve("data/generated/wx/tfr.json");
const WFS =
  "https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=1000&outputFormat=application/json&srsname=EPSG:4326";
const LIST = "https://tfr.faa.gov/tfrapi/getTfrList";

const round = (c) => (Array.isArray(c[0]) ? c.map(round) : [Math.round(c[0] * 1e4) / 1e4, Math.round(c[1] * 1e4) / 1e4]);

/** "6/4240-1-FDC-F" -> "6/4240" */
export const notamId = (key) => String(key || "").split("-")[0];

const KIND = { SECURITY: "Security", VIP: "VIP movement", HAZARDS: "Hazards", "SPACE OPERATIONS": "Space operations", "AIR SHOWS/SPORTS": "Air show / sports", "SPECIAL": "Special", "NATIONAL SECURITY": "National security" };

/** Merge the WFS shapes with the list's types into slim GeoJSON features. */
export function buildTfr(wfs, list) {
  const kinds = new Map((list || []).map((t) => [t.notam_id, t.type]));
  const features = [];
  for (const f of wfs.features || []) {
    if (!f.geometry || !["Polygon", "MultiPolygon"].includes(f.geometry.type)) continue;
    const p = f.properties || {};
    const id = notamId(p.NOTAM_KEY);
    if (!id) continue;
    const raw = (kinds.get(id) || p.LEGAL || "").toUpperCase();
    features.push({
      type: "Feature",
      geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) },
      properties: {
        id: `TFR:${id}`,
        type: "TFR",
        name: `TFR ${id}`,
        title: String(p.TITLE || "").trim(),
        kind: KIND[raw] || (raw ? raw[0] + raw.slice(1).toLowerCase() : ""),
        state: p.STATE || "",
        notam: id,
        modified: p.LAST_MODIFICATION_DATETIME || "",
      },
    });
  }
  return features;
}

async function main() {
  const [wfs, list] = await Promise.all([fetchJsonWithRetry(WFS, {}, { retries: 3, baseDelayMs: 3000 }), fetchJsonWithRetry(LIST, {}, { retries: 3, baseDelayMs: 3000 }).catch(() => [])]);
  const features = buildTfr(wfs, list);
  if (!features.length && (wfs.features || []).length) throw new Error("TFR feed had shapes but none were usable");
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ builtAt: new Date().toISOString(), source: "FAA TFR (tfr.faa.gov)", type: "FeatureCollection", features }));
  console.log(`Wrote ${features.length} TFR shapes.`);
}

if (process.argv[1]?.endsWith("fetch-tfr.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
