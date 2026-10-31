#!/usr/bin/env node
// Instrument approaches per nav-list field, from the FAA Digital Terminal
// Procedures Publication metadata (d-TPP, 28-day cycle). Written to
// data/generated/approaches.json as the chart names per field; the app
// classifies them (assets/js/planner/approaches.js).
//
//   node scripts/fetch-approaches.js            full run
//   node scripts/fetch-approaches.js --probe    print the XML's shape, write nothing

import { readFile, writeFile } from "node:fs/promises";
import { airacCycle } from "./lib/nasr.js";

const DAY = 86400000;
const OUT = "data/generated/approaches.json";

/** d-TPP cycle id "YYNN": year + the cycle's ordinal within that year (01 = first AIRAC date of the year). */
export function dtppCycleId(effective) {
  const year = effective.getUTCFullYear();
  let first = airacCycle(Date.UTC(year, 0, 1));
  if (first.getUTCFullYear() < year) first = new Date(first.getTime() + 28 * DAY);
  const n = Math.round((effective - first) / DAY / 28) + 1;
  return `${String(year).slice(2)}${String(n).padStart(2, "0")}`;
}

/** Parse d-TPP metadata XML -> Map(ident -> chart names) for IAP charts. Idents: ICAO and FAA, as listed. */
export function parseDtpp(xml) {
  const out = new Map();
  for (const m of xml.matchAll(/<airport_name\b([^>]*)>([\s\S]*?)<\/airport_name>/g)) {
    const attrs = m[1];
    const idents = ["icao_ident", "apt_ident"].map((a) => attrs.match(new RegExp(`${a}="([^"]*)"`))?.[1]).filter(Boolean);
    const names = [];
    for (const r of m[2].matchAll(/<record>([\s\S]*?)<\/record>/g)) {
      if (!/<chart_code>IAP<\/chart_code>/.test(r[1])) continue;
      const name = r[1].match(/<chart_name>([^<]*)<\/chart_name>/)?.[1];
      if (name) names.push(name.replace(/&amp;/g, "&").replace(/&apos;/g, "'").trim());
    }
    for (const id of idents) out.set(id, names);
  }
  return out;
}

async function download() {
  const effective = airacCycle();
  const ids = [0, -1, 1].map((d) => dtppCycleId(new Date(effective.getTime() + d * 28 * DAY)));
  for (const id of ids) {
    // the FAA's notices call it d-TPP_Metafile.xml; older tooling used ..._Metadata.xml
    for (const file of ["d-TPP_Metafile.xml", "d-TPP_Metadata.xml"]) {
      const url = `https://aeronav.faa.gov/d-tpp/${id}/xml_data/${file}`;
      const res = await fetch(url);
      console.log(`${url} -> HTTP ${res.status}`);
      if (res.ok) return { id, xml: await res.text() };
    }
  }
  throw new Error("no d-TPP metadata found for this or the neighbouring cycles");
}

async function main() {
  const { id, xml } = await download();
  console.log(`d-TPP ${id}: ${(xml.length / 1e6).toFixed(1)} MB`);

  if (process.argv.includes("--probe")) {
    console.log(xml.slice(0, 700));
    const i = xml.indexOf("<airport_name");
    console.log(xml.slice(i, i + 1200));
    const parsed = parseDtpp(xml);
    console.log(`${parsed.size} idents; KOKC:`, parsed.get("KOKC"));
    return;
  }

  const parsed = parseDtpp(xml);
  const nav = JSON.parse(await readFile("data/curated/navinfo.json", "utf-8"));
  const facts = JSON.parse(await readFile("data/generated/field-facts.json", "utf-8")).facts;
  const airports = {};
  for (const f of nav.fields) {
    const cands = [f.code, facts[f.code]?.faaId, f.code.length === 4 && f.code.startsWith("K") ? f.code.slice(1) : null].filter(Boolean);
    const hit = cands.map((c) => parsed.get(c)).find((v) => v);
    if (hit) airports[f.code] = [...new Set(hit)].sort();
  }
  console.log(`${Object.keys(airports).length}/${nav.fields.length} nav-list fields have published approaches`);
  await writeFile(OUT, JSON.stringify({ builtAt: new Date().toISOString(), cycle: id, source: "FAA d-TPP metadata", airports }));
}

if (process.argv[1]?.endsWith("fetch-approaches.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
