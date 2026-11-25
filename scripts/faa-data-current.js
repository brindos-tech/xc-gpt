// Is a published FAA data file already built from the 28-day cycle in force now (and under 6 days old)?
// Used by the daily refresh workflows to end early, so they rebuild (and commit) only when a new cycle has
// started or the weekly catch-up is due. Prints "current=true|false" for $GITHUB_OUTPUT.
// usage: node scripts/faa-data-current.js <file.json>
import { readFileSync } from "node:fs";
import { airacCycle } from "./lib/nasr.js";

const MAX_AGE_MS = 6 * 86400000;

/** @param {{builtAt?:string, nasrCycle?:string}} file */
export function isCurrent(file, now = Date.now()) {
  const cycle = airacCycle(now);
  const built = Date.parse(file?.builtAt);
  if (!Number.isFinite(built) || now - built > MAX_AGE_MS) return false;
  // field facts name the NASR cycle they came from (the build falls back to the previous one when the FAA is late)
  if (file.nasrCycle) return file.nasrCycle === cycle.toISOString().slice(0, 10);
  // others: built at least a day after the cycle began, by which time the FAA has published it
  return built >= cycle.getTime() + 86400000;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let file = null;
  try {
    file = JSON.parse(readFileSync(process.argv[2], "utf8"));
  } catch {
    // missing or unreadable: rebuild
  }
  const current = isCurrent(file);
  console.log(`${process.argv[2]}: built ${file?.builtAt || "never"}${file?.nasrCycle ? `, NASR cycle ${file.nasrCycle}` : ""}; cycle in force ${airacCycle().toISOString().slice(0, 10)} -> ${current ? "current, nothing to do" : "rebuild"}`);
  console.log(`current=${current}`);
}
