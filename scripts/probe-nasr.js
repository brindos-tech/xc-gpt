#!/usr/bin/env node
// One-off look at the NASR CSV bundles that might say which approach control serves a field (not used by the build).
// Prints each bundle's files and column names, and the rows that mention a sample airport. Run from the data workflow with probe=true.
import { readdirSync } from "node:fs";
import path from "node:path";
import { downloadNasr, readNasrCsv } from "./lib/nasr.js";
import { parseCsvObjects } from "./lib/csv.js";

const SAMPLES = ["APA", "KAPA", "CENTENNIAL"];
for (const bundle of ["TWR", "FRQ", "ATC", "COM", "ATS", "STARS", "LID"]) {
  try {
    const { dir, cycle } = await downloadNasr(bundle);
    const files = readdirSync(dir).filter((f) => /\.csv$/i.test(f));
    console.log(`\n=== ${bundle} (cycle ${cycle}): ${files.join(", ")}`);
    for (const f of files) {
      let rows;
      try {
        rows = parseCsvObjects(readNasrCsv(dir, f));
      } catch (err) {
        console.log(`  ${f}: unreadable (${err.message})`);
        continue;
      }
      console.log(`  ${f}: ${rows.length} rows; columns: ${Object.keys(rows[0] || {}).join(", ")}`);
      const hits = rows.filter((r) => Object.values(r).some((v) => SAMPLES.includes(String(v).toUpperCase().trim())));
      for (const r of hits.slice(0, 4)) console.log(`    ${JSON.stringify(r).slice(0, 700)}`);
    }
  } catch (err) {
    console.log(`\n=== ${bundle}: ${err.message}`);
  }
}
