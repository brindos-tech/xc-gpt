#!/usr/bin/env node
// Import the DoD FLIP Area Planning books (text exports) into
// data/curated/ap1.json — the scheduling details the FAA's public data
// doesn't carry:
//
//   AP/1A (Special Use Airspace): per MOA / Restricted / Warning / Alert
//     area, the using/scheduling agency (with DSN/commercial numbers) and
//     the "airspace activity" contact; plus the MOA scheduling table
//     (scheduling point, location, phone).
//   AP/1B (Military Training Routes): per IR / VR / SR route, the
//     originating and scheduling activities, hours of operation, width,
//     remarks and point coordinates. SR routes exist only here — NASR has
//     no SR data at all.
//
// Run locally each 8-week FLIP cycle:
//   node scripts/import-ap1.mjs path/to/AP1A_SUA.txt path/to/AP1B_MTR.txt
// Geometry still comes from the FAA (scripts/fetch-airspace.js); this file
// only enriches it (and supplies route geometry the FAA layer lacks).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve("data/curated/ap1.json");

export const normKey = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const squash = (s) => s.replace(/\s+/g, " ").trim();

function effectiveDate(text) {
  const m = text.match(/EFFECTIVE 0001L\s+(\d{1,2} [A-Z]{3} \d{4})/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- AP/1A

const AP1A_BOILER = [
  /^===== original page/,
  /^\d+ UNITED STATES\s*$/,
  /^UNITED STATES \d+\s*$/,
  /^\s*(CONTROLLING|AGENCY|EFFECTIVE)\s*$/,
  /^\s*NUMBER\s+AREA NAME/,
  /^\s+(MILITARY OPERATING AREAS|RESTRICTED AREAS|WARNING AREAS|ALERT AREAS)/,
];
const SUA_START = /^(MOA US \d+|R\d{3,4}[A-Z0-9]{0,3}|W\d{2,4}[A-Z0-9]{0,3}|A\d{2,4}[A-Z0-9]{0,3})\s{2,}(\S.*)$/;

export function parseAp1a(text) {
  const lines = text.split("\n").filter((l) => !AP1A_BOILER.some((re) => re.test(l)));
  const areas = {};
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const body = squash(cur.body.join(" "));
    const using = body.match(/\* ?Using(?:\/Sked)? Agcy-\s*(.+?)(?:\(\d{2} [A-Z]{3} \d{4}\)|$)/i);
    const activity = body.match(/AIRSPACE ACTIVITY,? ctc ([A-Z0-9 /&.'-]+?)\s+(\d{3}\.\d{1,3})/i);
    areas[cur.key] = {
      designator: cur.designator,
      name: cur.name,
      using: using ? squash(using[1]).replace(/[.\s]+$/, "") : null,
      activity: activity ? `${squash(activity[1])} ${activity[2]}` : null,
    };
    cur = null;
  };
  let inSchedTable = false;
  for (const line of lines) {
    if (/^III\. MOA SCHEDULING INFORMATION/.test(line)) {
      flush();
      inSchedTable = true;
      continue;
    }
    if (inSchedTable) continue;
    const m = line.match(SUA_START);
    if (m) {
      flush();
      const isMoa = m[1].startsWith("MOA");
      // "ABEL EAST MOA, CA   5000' to ..." -> name up to the state code
      const name = squash((m[2].match(/^(.+?, [A-Z]{2})\b/) || [null, m[2].split(/\s{2,}/)[0]])[1]).replace(/, [A-Z]{2}$/, "");
      const designator = isMoa ? name : m[1];
      cur = { key: normKey(isMoa ? name : m[1]), designator, name, body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
  }
  flush();
  return { areas, moaSchedulers: parseMoaTable(text) };
}

export function parseMoaTable(text) {
  const start = text.indexOf("III. MOA SCHEDULING INFORMATION");
  if (start < 0) return [];
  const end = text.indexOf("BOUNDARIES OF DO", start);
  const lines = text.slice(start, end > 0 ? end : undefined).split("\n").slice(1);
  const rows = [];
  let cur = null;
  for (const raw of lines) {
    if (!raw.trim() || /^MOA NAME|^=====|^\s*\d+ UNITED STATES|^UNITED STATES \d+/.test(raw)) continue;
    const cols = raw.split(/\s{2,}/);
    const startsName = !/^\s/.test(raw);
    if (startsName && (!cur || cur.done)) {
      cur = { name: "", agency: [], location: [], phone: [], done: false };
      rows.push(cur);
    }
    if (!cur) continue;
    if (startsName) {
      cur.name = squash(`${cur.name} ${cols.shift()}`);
      if (/, [A-Z]{2}$/.test(cur.name)) cur.done = true;
    } else cols.shift(); // leading blank from indentation
    // remaining columns: agency, location, phone — but continuation lines
    // only fill the columns they reach; phone continuations sit far right
    const rest = cols.filter(Boolean);
    if (rest.length === 3) {
      cur.agency.push(rest[0]);
      cur.location.push(rest[1]);
      cur.phone.push(rest[2]);
    } else if (rest.length === 1 && /^[C\d]/.test(rest[0]) && /\d{3}/.test(rest[0])) cur.phone.push(rest[0]);
    else if (rest.length === 1) cur.agency.push(rest[0]);
    else if (rest.length === 2) {
      cur.agency.push(rest[0]);
      cur.location.push(rest[1]);
    }
  }
  const isPhone = (x) => /^(DSN |C)?\d{3}-\d{3,4}/.test(x) || /^C\d{3}-/.test(x);
  for (const r of rows) {
    // a phone continuation can land in the location column ("C559-998-1034")
    const loc = r.location.filter((x) => !isPhone(x));
    r.phone.push(...r.location.filter(isPhone));
    r.location = loc;
  }
  return rows.map((r) => ({
    names: r.name.replace(/, [A-Z]{2}$/, ""),
    state: (r.name.match(/, ([A-Z]{2})$/) || [])[1] || null,
    agency: squash(r.agency.join(" ")),
    location: squash(r.location.join(" ")),
    phone: squash(r.phone.join(" ")),
  }));
}

/** Find the scheduling row for an FAA MOA name ("VANCE 1A MOA"). */
export function findMoaScheduler(rows, moaName) {
  const tokens = normWords(moaName.replace(/\bMOA\b/i, "")).filter((t) => t.length > 0);
  if (!tokens.length) return null;
  let best = null;
  let bestScore = 0;
  for (const r of rows) {
    const words = new Set(normWords(r.names));
    if (!words.has(tokens[0])) continue; // the area's base name must match
    const score = tokens.filter((t) => words.has(t)).length;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}
const normWords = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------- AP/1B

const AP1B_BOILER = [/^===== original page/, /^\s*\d{1,2} [A-Z]{3} \d{4} - \d{4}\s+.*ROUTES\s*$/, /^\s*(IR|VR|SR) ROUTES\s+\d{1,2} [A-Z]{3} \d{4} - \d{4}\s*$/, /^\s+\d-\d+\s*$/];
const ROUTE_START = /^(IR|VR|SR)-(\d{3,4})\s*$/;
const FIELD = /^(ORIGINATING ACTIVITY|SCHEDULING ACTIVITY|HOURS OF OPERATION|ROUTE DESCRIPTION|ROUTE WIDTH|Remarks)\s*[:-]?\s*(.*)$/;

function dm(deg, min) {
  return Number(deg) + Number(min) / 60;
}

// Page headers that survive the line filter because the text export
// interleaved two of them ("7 AUG 14 MAY2025 2026- -2508 2605 VR ROUTES").
const MANGLED_HEADER = /\s*\b\d{1,2} [A-Z]{3}\b[\s\dA-Z-]*?\b(?:IR|VR|SR) ROUTES\b/g;
const TRAILING_HEADER = /\s*\b(?:IR|VR|SR) ROUTES\b(?:\s+-?[0-9A-Z]{1,4}-?)*|\s+-\s\d{4}$/g;
export const stripHeaders = (s) =>
  s ? s.replace(MANGLED_HEADER, "").replace(TRAILING_HEADER, "").replace(/\s*INTENTIONALLY LEFT BLANK\s*/g, " ").trim() : s;

/** "5 NM either side ... Special Operating Procedures: (1) ..." -> { width, sop } */
export function splitSop(widthText) {
  if (!widthText) return { width: null, sop: null };
  const i = widthText.search(/Special Operating Procedures:/i);
  if (i < 0) return { width: widthText, sop: null };
  return {
    width: widthText.slice(0, i).trim() || null,
    sop: widthText.slice(i).replace(/^Special Operating Procedures:\s*/i, "").slice(0, 4000) || null,
  };
}

export function parseAp1b(text) {
  const routes = {};
  let cur = null;
  let field = null;
  let pendingLat = null;
  const flush = () => {
    if (!cur) return;
    const t = (k) => (cur.f[k] ? stripHeaders(squash(cur.f[k].join(" "))) : null);
    const sched = t("SCHEDULING ACTIVITY");
    routes[cur.id] = {
      area: cur.area,
      originating: t("ORIGINATING ACTIVITY"),
      scheduling: sched && /^same as/i.test(sched) ? t("ORIGINATING ACTIVITY") : sched,
      hours: t("HOURS OF OPERATION"),
      ...splitSop(t("ROUTE WIDTH")),
      remarks: t("Remarks")?.slice(0, 1500) || null,
      points: cur.points,
    };
    cur = null;
  };
  for (const line of text.split("\n")) {
    if (AP1B_BOILER.some((re) => re.test(line))) continue;
    // refueling tracks follow the SR chapter (the table of contents near
    // the top names the chapter too, so only stop once routes are in)
    if (Object.keys(routes).length && /^CHAPTER 5\b|^REFUELING TRACKS/.test(line.trim())) {
      flush();
      break;
    }
    // a chapter intro (e.g. the SR general notes) is not part of the
    // last route of the previous chapter
    if (/^\s*CHAPTER \d/i.test(line)) {
      flush();
      field = null;
      continue;
    }
    const rs = line.match(ROUTE_START);
    if (rs) {
      flush();
      cur = { id: `${rs[1]}-${rs[2]}`, area: null, f: {}, points: [] };
      field = null;
      continue;
    }
    if (!cur) continue;
    if (!cur.area && /^\(([^)]+)\)\s*$/.test(line.trim())) {
      cur.area = line.trim().slice(1, -1);
      continue;
    }
    const fm = line.match(FIELD);
    if (fm) {
      field = fm[1];
      cur.f[field] = fm[2] ? [fm[2]] : [];
      continue;
    }
    if (field === "ROUTE DESCRIPTION") {
      const lat = line.match(/N(\d{2})°(\d{2}(?:\.\d+)?)'/);
      const lon = line.match(/W(\d{2,3})°(\d{2}(?:\.\d+)?)'/);
      if (lat) pendingLat = dm(lat[1], lat[2]);
      if (lon && pendingLat != null) {
        cur.points.push([Number(pendingLat.toFixed(4)), Number((-dm(lon[1], lon[2])).toFixed(4))]);
        pendingLat = null;
      }
      continue;
    }
    if (field && line.trim()) cur.f[field].push(line.trim());
  }
  flush();
  return routes;
}

function main() {
  const [ap1aPath, ap1bPath] = process.argv.slice(2);
  if (!ap1aPath || !ap1bPath) {
    console.error("usage: node scripts/import-ap1.mjs AP1A_SUA.txt AP1B_MTR.txt");
    process.exit(1);
  }
  const a = readFileSync(ap1aPath, "utf-8");
  const b = readFileSync(ap1bPath, "utf-8");
  const { areas, moaSchedulers } = parseAp1a(a);
  const routes = parseAp1b(b);
  const out = {
    source: { ap1a: `AP/1A effective ${effectiveDate(a)}`, ap1b: `AP/1B effective ${effectiveDate(b)}` },
    areas,
    moaSchedulers,
    routes,
  };
  writeFileSync(OUT, JSON.stringify(out) + "\n");
  const byType = Object.keys(routes).reduce((m, k) => ((m[k.slice(0, 2)] = (m[k.slice(0, 2)] || 0) + 1), m), {});
  console.log(`AP/1A: ${Object.keys(areas).length} areas, ${moaSchedulers.length} MOA scheduling rows`);
  console.log(`AP/1B: ${Object.keys(routes).length} routes ${JSON.stringify(byType)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
