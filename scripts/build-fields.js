#!/usr/bin/env node
// Builds data/generated/field-facts.json: for every airfield on the Vance
// Nav Info List (data/curated/navinfo.json), the public facts the list
// itself doesn't carry —
//   - position, elevation, longest runway, tower type, fuel types,
//     contract-fuel flag, attendance hours, hangar/landing-fee flags and
//     county, from the FAA NASR 28-day subscription (APT CSV bundle)
//   - GSA CONUS per diem (lodging by month + M&IE) for the field's
//     county, current and next fiscal year when published
// The page merges these with the curated list at load time, so an edit to
// navinfo.json shows up immediately and this only has to run weekly.
//
// Optional env: GSA_API_KEY (api.data.gov key; DEMO_KEY otherwise — this
// makes at most two calls a run, well inside the demo limits).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { downloadNasr, readNasrCsv } from "./lib/nasr.js";
import { parseCsvObjects } from "./lib/csv.js";
import { buildPerDiemIndex, fiscalYear } from "./lib/perdiem.js";

const NAVINFO = path.resolve("data/curated/navinfo.json");
const CONFIG = path.resolve("data/curated/config.json");
const OUT = path.resolve("data/generated/field-facts.json");
const GSA_KEY = process.env.GSA_API_KEY || "DEMO_KEY";

/** Nav list codes are ICAO-ish ("KOKC", "K79J") or FAA ids ("1R8"). */
export function matchAirport(code, byIcao, byFaa) {
  return byIcao.get(code) || byFaa.get(code) || (code.length === 4 && code[0] === "K" ? byFaa.get(code.slice(1)) : null) || null;
}

export function longestRunway(rows) {
  const rwys = rows.filter((r) => !/^H/.test(r.RWY_ID)).map((r) => ({
    id: r.RWY_ID,
    len: Number(r.RWY_LEN) || 0,
    width: Number(r.RWY_WIDTH) || 0,
    surface: r.SURFACE_TYPE_CODE,
  }));
  rwys.sort((a, b) => b.len - a.len);
  return rwys[0] || null;
}

/** Every non-helicopter runway at least minLen × minWidth feet, longest first (the crew card lists them all). */
export function usableRunways(rows, minLen = 4000, minWidth = 75) {
  return rows
    .filter((r) => !/^H/.test(r.RWY_ID))
    .map((r) => ({ id: r.RWY_ID, len: Number(r.RWY_LEN) || 0, width: Number(r.RWY_WIDTH) || 0, surface: r.SURFACE_TYPE_CODE }))
    .filter((r) => r.len >= minLen && r.width >= minWidth)
    .sort((a, b) => b.len - a.len);
}

/** Runway ends flown with a right-hand traffic pattern ("17", "35L"), from NASR APT_RWY_END.csv rows of one airport. */
export function rightTrafficEnds(rows) {
  return rows.filter((r) => r.RIGHT_HAND_TRAFFIC_PAT_FLAG === "Y" && !/^H/.test(r.RWY_ID || "")).map((r) => r.RWY_END_ID).filter(Boolean);
}

/** The overlying air route traffic control center, from an APT_BASE row. */
export function artccOf(a) {
  const id = a.RESP_ARTCC_ID || "";
  return id ? { id, name: (a.RESP_ARTCC_NAME || "").replace(/\s+(ARTCC|CENTER)$/i, "").trim() } : null;
}

/**
 * The approach / departure control that serves a tower, from its NASR ATC_BASE.csv row: {approach:{call,id}, departure?:{call,id}}
 * ("DENVER", "D01" for Centennial), or null. A plain "ATCT" tower has none of its own; this is the separate facility that does.
 */
export function approachOf(row) {
  if (!row) return null;
  const one = (call, id) => {
    const c = String(call || "").trim();
    const i = String(id || "").trim();
    return c || i ? { call: c, id: i } : null;
  };
  const approach = one(row.PRIMARY_APCH_RADIO_CALL, row.APCH_P_PROVIDER);
  const departure = one(row.PRIMARY_DEP_RADIO_CALL, row.DEP_P_PROVIDER);
  if (!approach && !departure) return null;
  const out = { approach: approach || departure };
  if (approach && departure && (approach.call !== departure.call || approach.id !== departure.id)) out.departure = departure;
  return out;
}

export function attendanceText(rows) {
  return rows
    .sort((a, b) => Number(a.SKED_SEQ_NO) - Number(b.SKED_SEQ_NO))
    .map((r) => [r.MONTH, r.DAY, r.HOUR].filter((x) => x && x !== "ALL").join(" ") || (r.MONTH === "ALL" ? "24/7" : r.MONTH))
    .join("; ");
}

async function gsaLodging(fy) {
  const res = await fetch(`https://api.gsa.gov/travel/perdiem/v2/rates/conus/lodging/${fy}?api_key=${GSA_KEY}`);
  if (!res.ok) throw new Error(`GSA FY${fy}: HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`GSA FY${fy}: no rows`);
  return rows;
}

async function main() {
  const navinfo = JSON.parse(await readFile(NAVINFO, "utf-8"));
  const config = JSON.parse(await readFile(CONFIG, "utf-8"));
  const codes = new Set([...navinfo.fields.map((f) => f.code), ...config.origins.map((o) => o.icao)]);

  const { dir, cycle } = await downloadNasr("APT");
  const base = parseCsvObjects(readNasrCsv(dir, "APT_BASE.csv"));
  const rwys = parseCsvObjects(readNasrCsv(dir, "APT_RWY.csv"));
  const att = parseCsvObjects(readNasrCsv(dir, "APT_ATT.csv"));
  let rwyEnds = [];
  try {
    rwyEnds = parseCsvObjects(readNasrCsv(dir, "APT_RWY_END.csv"));
  } catch (err) {
    console.log(`No APT_RWY_END.csv (${err.message}): right-traffic runways will be missing`);
  }
  if (rwyEnds.length && !("RIGHT_HAND_TRAFFIC_PAT_FLAG" in rwyEnds[0])) console.log(`APT_RWY_END columns: ${Object.keys(rwyEnds[0]).join(", ")}`);
  if (base.length && !("RESP_ARTCC_ID" in base[0])) console.log(`APT_BASE has no RESP_ARTCC_ID; columns: ${Object.keys(base[0]).join(", ")}`);
  console.log(`NASR cycle ${cycle}: ${base.length} airports, ${rwys.length} runways`);

  // which approach control serves each tower (a separate NASR bundle; without it the card just does not name one)
  const atcByFaa = new Map();
  try {
    const atc = await downloadNasr("ATC");
    for (const r of parseCsvObjects(readNasrCsv(atc.dir, "ATC_BASE.csv"))) if (r.SITE_TYPE_CODE === "A" && r.FACILITY_ID) atcByFaa.set(r.FACILITY_ID, r);
    console.log(`ATC bundle ${atc.cycle}: ${atcByFaa.size} towers`);
  } catch (err) {
    console.log(`No ATC bundle (${err.message}): approach control will not be named`);
  }

  const byIcao = new Map(base.filter((r) => r.ICAO_ID).map((r) => [r.ICAO_ID, r]));
  const byFaa = new Map(base.map((r) => [r.ARPT_ID, r]));
  const group = (rows) => rows.reduce((m, r) => (m.get(r.SITE_NO)?.push(r) ?? m.set(r.SITE_NO, [r]), m), new Map());
  const rwyBySite = group(rwys);
  const attBySite = group(att);
  const endsBySite = group(rwyEnds);

  // per diem: current FY always; next FY once GSA publishes it (August)
  const perDiem = {};
  const fy = fiscalYear(new Date());
  for (const year of [fy, fy + 1]) {
    try {
      perDiem[year] = buildPerDiemIndex(await gsaLodging(year));
    } catch (err) {
      console.log(`Per diem FY${year} not available: ${err.message}`);
    }
  }
  console.log(`Per diem years: ${Object.keys(perDiem).join(", ") || "none"}`);

  const facts = {};
  const unmatched = [];
  for (const code of codes) {
    const a = matchAirport(code, byIcao, byFaa);
    if (!a) {
      unmatched.push(code);
      continue;
    }
    const pd = {};
    for (const [year, lookup] of Object.entries(perDiem)) {
      const hit = lookup(a.STATE_CODE, a.COUNTY_NAME, a.CITY);
      if (hit) pd[year] = hit;
    }
    facts[code] = {
      faaId: a.ARPT_ID,
      lat: Number(Number(a.LAT_DECIMAL).toFixed(5)),
      lon: Number(Number(a.LONG_DECIMAL).toFixed(5)),
      elevFt: Math.round(Number(a.ELEV)) || null,
      faaName: a.ARPT_NAME,
      faaCity: a.CITY,
      county: a.COUNTY_NAME,
      state: a.STATE_CODE,
      tower: a.TWR_TYPE_CODE || null,
      fuelTypes: a.FUEL_TYPES ? a.FUEL_TYPES.split(",").map((s) => s.trim()).filter(Boolean) : [],
      contractFuel: a.CONTR_FUEL_AVBL === "Y" ? true : a.CONTR_FUEL_AVBL === "N" ? false : null,
      landingFee: a.LNDG_FEE_FLAG === "Y" ? true : a.LNDG_FEE_FLAG === "N" ? false : null,
      hangar: a.TRNS_STRG_HGR_FLAG === "Y",
      attendance: attendanceText(attBySite.get(a.SITE_NO) || []) || null,
      runway: longestRunway(rwyBySite.get(a.SITE_NO) || []),
      runways: usableRunways(rwyBySite.get(a.SITE_NO) || []),
      artcc: artccOf(a),
      ...(a.TWR_TYPE_CODE && !/^NON/.test(a.TWR_TYPE_CODE) ? approachOf(atcByFaa.get(a.ARPT_ID)) : {}),
      rightTraffic: rightTrafficEnds(endsBySite.get(a.SITE_NO) || []),
      ownership: a.OWNERSHIP_TYPE_CODE,
      perDiem: pd,
    };
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ builtAt: new Date().toISOString(), nasrCycle: cycle, perDiemYears: Object.keys(perDiem).map(Number), unmatched, facts }));
  console.log(`Wrote facts for ${Object.keys(facts).length} fields; ${unmatched.length} unmatched: ${unmatched.join(" ") || "none"}`);
  if (Object.keys(facts).length < codes.size * 0.9) {
    console.error("Fewer than 90% of fields matched NASR — refusing to publish a hollowed-out file.");
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
