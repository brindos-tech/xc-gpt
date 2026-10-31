// FAA NASR 28-day subscription helpers. The CSV bundles are public at
// nfdc.faa.gov and published on the AIRAC cycle (every 28 days, Thursdays).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const AIRAC_EPOCH = Date.UTC(2024, 0, 25); // a known AIRAC effective date
const DAY = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Effective date (UTC midnight) of the AIRAC cycle in force at `when`. */
export function airacCycle(when = Date.now()) {
  const n = Math.floor((when - AIRAC_EPOCH) / DAY / 28);
  return new Date(AIRAC_EPOCH + n * 28 * DAY);
}

export function cycleLabel(d) {
  return `${String(d.getUTCDate()).padStart(2, "0")}_${MONTHS[d.getUTCMonth()]}_${d.getUTCFullYear()}`;
}

/**
 * Download and unzip one NASR CSV bundle (e.g. "APT", "MTR") for the current
 * cycle, falling back to the previous cycle if the new one isn't posted yet.
 * Returns { dir, cycle } where dir holds the extracted CSVs.
 */
export async function downloadNasr(bundle, when = Date.now()) {
  let lastErr;
  for (const back of [0, 1]) {
    const cycle = airacCycle(when - back * 28 * DAY);
    const url = `https://nfdc.faa.gov/webContent/28DaySub/extra/${cycleLabel(cycle)}_${bundle}_CSV.zip`;
    const res = await fetch(url);
    if (!res.ok) {
      lastErr = new Error(`${url} -> HTTP ${res.status}`);
      continue;
    }
    const dir = mkdtempSync(path.join(tmpdir(), `nasr-${bundle}-`));
    writeFileSync(path.join(dir, "bundle.zip"), Buffer.from(await res.arrayBuffer()));
    execFileSync("unzip", ["-o", "-q", "bundle.zip"], { cwd: dir });
    return { dir, cycle: cycle.toISOString().slice(0, 10) };
  }
  throw lastErr;
}

export function readNasrCsv(dir, file) {
  // NASR CSVs are Latin-1 in practice (names like "MAYAGÜEZ")
  return readFileSync(path.join(dir, file), "latin1");
}
