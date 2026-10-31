// Instrument-approach types for the planner's training filter. Chart names
// come from the FAA d-TPP metadata (scripts/fetch-approaches.js), e.g.
// "ILS OR LOC RWY 17R", "LOC BC RWY 35", "VOR-A", "RNAV (GPS) Y RWY 31".
// Civil procedures only: DoD-only (e.g. FLIP hi-altitude) approaches aren't
// in this data.

export const APPROACH_TYPES = [
  { key: "ILS", label: "ILS", title: "ILS (precision) approach" },
  { key: "LOC", label: "LOC", title: "Localizer approach (front course)" },
  { key: "LOCBC", label: "LOC BC", title: "Localizer back course" },
  { key: "VOR", label: "VOR", title: "VOR or VOR/DME approach" },
  { key: "RNAV", label: "RNAV / GPS", title: "RNAV (GPS) / RNP or GPS approach" },
  { key: "TACAN", label: "TACAN", title: "TACAN approach" },
  { key: "NDB", label: "NDB", title: "NDB approach" },
  { key: "CIRCLING", label: "Circling-only", title: "Approach with circling minimums only (no straight-in, e.g. VOR-A)" },
];
export const APPROACH_LABELS = Object.fromEntries(APPROACH_TYPES.map((t) => [t.key, t.label]));

/** Which training types one approach chart name provides. */
export function classifyApproach(name) {
  const n = String(name || "").toUpperCase();
  const out = new Set();
  if (/\bILS\b/.test(n)) out.add("ILS");
  if (/\bLOC\b.*\bBC\b|\bLOC\/DME BC\b|BACK ?COURSE/.test(n)) out.add("LOCBC");
  else if (/\bLOC\b|\bLDA\b|\bSDF\b/.test(n)) out.add("LOC");
  if (/\bVOR\b/.test(n)) out.add("VOR");
  if (/\bNDB\b/.test(n)) out.add("NDB");
  if (/RNAV|\bGPS\b|\bRNP\b/.test(n)) out.add("RNAV");
  if (/\bTACAN\b/.test(n)) out.add("TACAN");
  if (/-[A-Z]$/.test(n) && !/\bRWY\b/.test(n)) out.add("CIRCLING");
  return out;
}

/** Union of types over a list of chart names, in display order. */
export function approachTypes(names) {
  const all = new Set();
  for (const n of names || []) for (const t of classifyApproach(n)) all.add(t);
  return APPROACH_TYPES.map((t) => t.key).filter((k) => all.has(k));
}

/** True when a field has every selected type. */
export const hasApproachTypes = (f, selected) => [...selected].every((t) => (f.approachTypes || []).includes(t));
