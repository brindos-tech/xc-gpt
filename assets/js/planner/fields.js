// Planner field logic — pure functions over the nav info list
// (data/curated/navinfo.json) joined with the FAA/GSA facts built by
// scripts/build-fields.js (data/generated/field-facts.json).
import { greatCircleNm, flightMinutes } from "../geo.js";

/** Join the curated list with generated facts; fields without a position can't be mapped. */
export function mergeFields(navinfo, factsFile) {
  const facts = factsFile?.facts || {};
  return navinfo.fields.map((f) => {
    const x = facts[f.code] || {};
    return { ...f, ...x, id: f.code, hasPosition: Number.isFinite(x.lat) && Number.isFinite(x.lon) };
  });
}

/**
 * "P-coded" means the DoD FLIP classification the list carries ("P (with
 * DoD tenant)" / "P (without DoD tenant)") — fields usable for arrival
 * without being on an approval list (see the list's own header notes).
 */
export const isPCoded = (f) => /^P \(/.test(f.classification || "");

export const FIELD_FILTERS = [
  { key: "fuel", label: "Fuel approved", test: (f) => f.fuel === "Approved" },
  { key: "ron", label: "RON approved", test: (f) => f.ron === "Approved" },
  { key: "t6", label: "T-6 suitable", test: (f) => (f.suitability || []).includes("T-6") },
  { key: "fbo", label: "Has FBO", test: (f) => Boolean(f.fbo) },
  { key: "towered", label: "Towered", test: (f) => /^ATCT/.test(f.tower || "") },
  { key: "military", label: "Military / joint", test: (f) => /Military|MIL\/CIV|with DoD tenant/.test(f.classification || "") },
];

export function matchesSearch(f, q) {
  if (!q) return true;
  const hay = `${f.code} ${f.faaId || ""} ${f.name} ${f.city} ${f.stateName || ""} ${f.fbo || ""}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

/**
 * Fields for the current planner state, with distance/time from the
 * selected base. `outOfRange` ones are kept (dimmed on the map) only when
 * the user is searching, so a search can find a field past the ring.
 */
export function selectFields(fields, state, origin, config) {
  const filters = FIELD_FILTERS.filter((x) => state.fieldFilters?.has(x.key));
  const out = [];
  let inRange = 0;
  for (const f of fields) {
    if (!f.hasPosition) continue;
    if (state.fieldSource === "p" && !isPCoded(f)) continue;
    if (!filters.every((x) => x.test(f))) continue;
    if (!matchesSearch(f, state.search)) continue;
    const distanceNm = greatCircleNm(origin, f);
    const within = distanceNm <= state.rangeNm;
    if (!within && !state.search) continue;
    if (within) inRange++;
    out.push({ ...f, distanceNm, flightMinutes: flightMinutes(distanceNm, config.aircraft.cruiseKts), outOfRange: !within });
  }
  out.sort((a, b) => a.distanceNm - b.distanceNm);
  return { fields: out, inRange };
}

/** One word for the map pin: can we land, get gas and stay? */
export function fieldStatus(f) {
  if (f.land === "Not Approved") return "no";
  if (f.fuel === "Approved" && f.ron === "Approved" && f.land === "Approved") return "go";
  if (f.fuel === "Not Approved") return "nofuel";
  return "check";
}

export const STATUS_LABELS = {
  go: "Land · fuel · RON approved",
  check: "See comments (fuel/RON)",
  nofuel: "No fuel",
  no: "Landing not approved",
};

/** Government fuel contract signal: the list's own notes first, FAA's contract-fuel flag second. */
export function gfcStatus(f) {
  const notes = f.notes || "";
  if (/\bno (gfc|fuel contract|government fuel)/i.test(notes) || /\bFBO lost GFC\b/i.test(notes)) return { known: true, has: false, text: "No GFC (per nav info list)" };
  if (f.contractFuel === true) return { known: true, has: true, text: "Contract fuel available (FAA)" };
  return { known: false, has: null, text: "GFC not noted — verify before going" };
}

/** Federal fiscal year (FY2027 = Oct 2026 – Sep 2027). */
export const fiscalYear = (d) => (d.getMonth() >= 9 ? d.getFullYear() + 1 : d.getFullYear());

/** GSA lodging + M&IE for the field's county in the month of `date`. */
export function perDiemFor(f, date) {
  const fy = fiscalYear(date);
  const pd = f.perDiem?.[fy];
  if (!pd) return null;
  return { fy, area: pd.area, lodging: pd.lodging?.[date.getMonth()] ?? null, meals: pd.meals ?? null };
}

export function telHref(phone) {
  const digits = (phone || "").replace(/[^\d]/g, "");
  return digits.length >= 10 ? `tel:+1${digits.slice(-10)}` : null;
}
