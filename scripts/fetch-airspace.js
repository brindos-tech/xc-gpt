#!/usr/bin/env node
// Builds the planner's airspace layers from the FAA's public aeronautical
// data (AIS Open Data, ArcGIS feature services) plus NASR route metadata:
//
//   data/generated/airspace-sua.json  MOAs and Restricted / Warning / Alert
//                                     areas (polygons, altitudes, times)
//   data/generated/airspace-mtr.json  IR / VR / SR military training routes
//                                     (centerlines, altitudes, widths, and
//                                     for IR/VR: times of use + scheduling
//                                     agency from NASR)
//
// Lower 48 only. Geometry is generalized server-side (≈100 m) and rounded so
// the files stay small enough to load on a phone when a layer is toggled on.
//
// Scheduling details (using/scheduling agency, phones, hours, SOPs) come
// from the DoD FLIP AP/1A and AP/1B books via data/curated/ap1.json — see
// scripts/import-ap1.mjs. SR routes exist only there.
//
// Planning reference only — the page says so. FLIP/ForeFlight remain the
// source for actual route and airspace use.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { downloadNasr, readNasrCsv } from "./lib/nasr.js";
import { parseCsvObjects } from "./lib/csv.js";
import { normKey, findMoaScheduler } from "./import-ap1.mjs";

const BASE = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services";
const OUT_DIR = path.resolve("data/generated");
const CONUS = "-125.5,24,-66,49.6";
const SUA_TYPES = ["MOA", "R", "W", "A"];

async function queryAll(service, where, outFields) {
  const features = [];
  for (let offset = 0; ; offset += 1000) {
    const url =
      `${BASE}/${service}/FeatureServer/0/query?where=${encodeURIComponent(where)}` +
      `&geometry=${CONUS}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
      `&outFields=${outFields}&outSR=4326&geometryPrecision=3&maxAllowableOffset=0.002` +
      `&resultOffset=${offset}&resultRecordCount=1000&f=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${service}: HTTP ${res.status}`);
    const page = await res.json();
    if (page.error) throw new Error(`${service}: ${JSON.stringify(page.error)}`);
    features.push(...(page.features || []));
    if (!page.properties?.exceededTransferLimit && (page.features || []).length < 1000) break;
  }
  return features;
}

export function altitudeText(val, uom, code) {
  if (val == null || val === "") return null;
  const v = Number(val);
  if (code === "SFC" || (v === 0 && code !== "MSL")) return "SFC";
  if (uom === "FL") return `FL${String(v).padStart(3, "0")}`;
  const ft = Number.isFinite(v) ? v.toLocaleString("en-US") : val;
  return `${ft} ${code === "HEI" ? "AGL" : code === "STD" ? "(FL)" : "MSL"}`.trim();
}

/**
 * The MTR feature service types routes only as 0/1/2. NASR knows which
 * route ids are IR and which are VR, so pick the mapping by overlap rather
 * than hard-coding it: the type whose ids are mostly IR is IR, mostly VR is
 * VR, and the one left over (no NASR counterpart) is SR.
 */
export function mapMtrTypes(idsByType, irIds, vrIds) {
  const score = (ids, ref) => [...ids].filter((id) => ref.has(id)).length / Math.max(1, ids.size);
  const types = Object.keys(idsByType);
  const ir = types.reduce((a, b) => (score(idsByType[a], irIds) >= score(idsByType[b], irIds) ? a : b));
  const rest = types.filter((t) => t !== ir);
  const vr = rest.reduce((a, b) => (score(idsByType[a], vrIds) >= score(idsByType[b], vrIds) ? a : b));
  const out = { [ir]: "IR", [vr]: "VR" };
  for (const t of types) if (!out[t]) out[t] = "SR";
  return out;
}

async function loadAp1() {
  try {
    return JSON.parse(await readFile(path.resolve("data/curated/ap1.json"), "utf-8"));
  } catch {
    console.log("No data/curated/ap1.json — airspace will carry FAA data only.");
    return { areas: {}, moaSchedulers: [], routes: {} };
  }
}

async function buildSua(ap1) {
  const where = `TYPE_CODE IN (${SUA_TYPES.map((t) => `'${t}'`).join(",")})`;
  const feats = await queryAll("Special_Use_Airspace", where, "NAME,TYPE_CODE,UPPER_VAL,UPPER_UOM,UPPER_CODE,LOWER_VAL,LOWER_UOM,LOWER_CODE,TIMESOFUSE,CITY,STATE,CONT_AGENT,COMM_NAME,REMARKS");
  return {
    type: "FeatureCollection",
    features: feats
      .filter((f) => f.geometry)
      .map((f) => {
        const p = f.properties;
        return {
          type: "Feature",
          geometry: f.geometry,
          properties: {
            id: `${p.TYPE_CODE}:${p.NAME}`,
            name: p.NAME,
            type: p.TYPE_CODE,
            top: altitudeText(p.UPPER_VAL, p.UPPER_UOM, p.UPPER_CODE),
            bottom: altitudeText(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE),
            times: p.TIMESOFUSE || null,
            near: [p.CITY, p.STATE].filter(Boolean).join(", ") || null,
            controlling: p.CONT_AGENT || null,
            using: p.COMM_NAME || null,
            remarks: p.REMARKS || null,
            ...ap1Area(ap1, p),
          },
        };
      }),
  };
}

/** AP/1A details for one FAA SUA feature. */
export function ap1Area(ap1, p) {
  const area = ap1.areas[normKey(p.NAME)];
  const sched = p.TYPE_CODE === "MOA" ? findMoaScheduler(ap1.moaSchedulers, p.NAME) : null;
  return {
    sked: area?.using || null,
    activity: area?.activity || null,
    scheduler: sched ? { agency: sched.agency, location: sched.location, phone: sched.phone } : null,
  };
}

async function buildMtr(ap1) {
  const feats = await queryAll("MTRSegment", "1=1", "IDENT,MTR_TYPE,UPPER_VAL,UPPER_UOM,UPPER_CODE,LOWER_VAL,LOWER_UOM,LOWER_CODE,WIDTHLEFT,WIDTHRIGHT");
  const { dir } = await downloadNasr("MTR");
  const base = parseCsvObjects(readNasrCsv(dir, "MTR_BASE.csv"));
  const agy = parseCsvObjects(readNasrCsv(dir, "MTR_AGY.csv"));
  const wdth = parseCsvObjects(readNasrCsv(dir, "MTR_WDTH.csv"));
  const key = (t, id) => `${t}${id}`;
  const irIds = new Set(base.filter((r) => r.ROUTE_TYPE_CODE === "IR").map((r) => r.ROUTE_ID));
  const vrIds = new Set(base.filter((r) => r.ROUTE_TYPE_CODE === "VR").map((r) => r.ROUTE_ID));

  const idsByType = {};
  for (const f of feats) (idsByType[f.properties.MTR_TYPE] ??= new Set()).add(f.properties.IDENT);
  const typeMap = mapMtrTypes(idsByType, irIds, vrIds);
  console.log(`MTR type mapping: ${JSON.stringify(typeMap)} (route ids per type: ${Object.entries(idsByType).map(([t, s]) => `${t}=${s.size}`).join(", ")})`);

  const meta = new Map();
  for (const r of base) meta.set(key(r.ROUTE_TYPE_CODE, r.ROUTE_ID), { times: r.TIME_OF_USE || null, agencies: [], width: [] });
  for (const r of agy) {
    const m = meta.get(key(r.ROUTE_TYPE_CODE, r.ROUTE_ID));
    if (m) m.agencies.push({ role: r.AGENCY_TYPE === "O" ? "Originating" : "Scheduling", name: r.AGENCY_NAME, station: r.STATION || null, phone: r.COMMERCIAL_NO || null, dsn: r.DSN_NO || null, hours: r.HOURS || null });
  }
  for (const r of wdth) meta.get(key(r.ROUTE_TYPE_CODE, r.ROUTE_ID))?.width.push(r.WIDTH_TEXT);

  // one feature per route, segments merged into a MultiLineString
  const routes = new Map();
  for (const f of feats) {
    if (!f.geometry) continue;
    const p = f.properties;
    const type = typeMap[p.MTR_TYPE];
    const id = key(type, p.IDENT);
    if (!routes.has(id)) {
      const m = meta.get(id);
      routes.set(id, {
        type: "Feature",
        geometry: { type: "MultiLineString", coordinates: [] },
        properties: {
          id,
          name: `${type}-${p.IDENT}`,
          type,
          floors: new Set(),
          tops: new Set(),
          widthNm: 0,
          times: m?.times || null,
          agencies: m?.agencies || [],
          widthText: m?.width.join(" ").replace(/\s+/g, " ").slice(0, 600) || null,
        },
      });
    }
    const r = routes.get(id);
    const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
    r.geometry.coordinates.push(...lines);
    r.properties.floors.add(altitudeText(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE));
    r.properties.tops.add(altitudeText(p.UPPER_VAL, p.UPPER_UOM, p.UPPER_CODE));
    r.properties.widthNm = Math.max(r.properties.widthNm, (Number(p.WIDTHLEFT) || 0) + (Number(p.WIDTHRIGHT) || 0));
  }
  const features = [...routes.values()].map((r) => {
    const p = r.properties;
    p.altitudes = `${[...p.floors].filter(Boolean).join(" / ")} to ${[...p.tops].filter(Boolean).join(" / ")}`;
    delete p.floors;
    delete p.tops;
    Object.assign(p, ap1Route(ap1.routes[p.name]));
    return r;
  });

  // Routes AP/1B describes but the FAA layer lacks: draw them from AP/1B's
  // own point list (lower 48 only).
  let fromAp1 = 0;
  for (const [name, r] of Object.entries(ap1.routes)) {
    const id = name.replace("-", "");
    if (routes.has(id)) continue;
    const pts = r.points.filter(([lat, lon]) => lat < 50 && lat > 24 && lon > -126);
    if (pts.length < 2) continue;
    fromAp1++;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: pts.map(([lat, lon]) => [lon, lat]) },
      properties: { id, name, type: name.slice(0, 2), altitudes: null, widthNm: null, times: null, agencies: [], widthText: null, ...ap1Route(r) },
    });
  }
  if (fromAp1) console.log(`MTR: ${fromAp1} routes drawn from AP/1B points (not in the FAA layer)`);
  return { type: "FeatureCollection", features };
}

/** AP/1B details for one route; null fields fall back to NASR's. */
export function ap1Route(r) {
  if (!r) return {};
  return {
    area: r.area || null,
    originating: r.originating || null,
    scheduling: r.scheduling || null,
    hours: r.hours || null,
    width: r.width || null,
    sop: r.sop || null,
    remarks: r.remarks || null,
  };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const ap1 = await loadAp1();
  const sua = await buildSua(ap1);
  const byType = sua.features.reduce((m, f) => ((m[f.properties.type] = (m[f.properties.type] || 0) + 1), m), {});
  await writeFile(path.join(OUT_DIR, "airspace-sua.json"), JSON.stringify(sua));
  console.log(`SUA: ${sua.features.length} areas ${JSON.stringify(byType)}`);

  const mtr = await buildMtr(ap1);
  const byRoute = mtr.features.reduce((m, f) => ((m[f.properties.type] = (m[f.properties.type] || 0) + 1), m), {});
  await writeFile(path.join(OUT_DIR, "airspace-mtr.json"), JSON.stringify(mtr));
  console.log(`MTR: ${mtr.features.length} routes ${JSON.stringify(byRoute)}`);

  if (sua.features.length < 300 || mtr.features.length < 300) {
    console.error("Suspiciously few airspace features — refusing to publish.");
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
