// Planner field logic — pure functions over the nav info list
// (data/curated/navinfo.json) joined with the FAA/GSA facts built by
// scripts/build-fields.js (data/generated/field-facts.json).
import { greatCircleNm, flightMinutes } from "../geo.js";
import { approachTypes, hasApproachTypes } from "./approaches.js";

/**
 * Join the curated list with generated facts and the AIR Card merchant
 * export (data/curated/aircard.json); fields without a position can't be
 * mapped.
 */
export function mergeFields(navinfo, factsFile, aircard, approaches) {
  const facts = factsFile?.facts || {};
  const merchants = aircard?.airports || {};
  const procedures = approaches?.airports || {};
  return navinfo.fields.map((f) => {
    const x = facts[f.code] || {};
    return { ...f, ...x, id: f.code, aircard: merchants[f.code] || [], approaches: procedures[f.code] || [], approachTypes: approachTypes(procedures[f.code]), hasPosition: Number.isFinite(x.lat) && Number.isFinite(x.lon) };
  });
}

/**
 * "P-coded" means the DoD FLIP classification the list carries ("P (with
 * DoD tenant)" / "P (without DoD tenant)") — fields usable for arrival
 * without being on an approval list (see the list's own header notes).
 */
export const isPCoded = (f) => /^P \(/.test(f.classification || "");

export const FIELD_FILTERS = [
  { key: "fuel", label: "Fuel available", test: (f) => f.fuel === "Approved" },
  { key: "dla", label: "DLA fuel contract", test: (f) => hasContractMerchant(f) },
  { key: "aircard", label: "AIR Card on-site", test: (f) => (f.aircard || []).some((m) => m.onSite) },
  { key: "t6", label: "T-6 suitable", test: (f) => (f.suitability || []).includes("T-6") },
  { key: "fbo", label: "Has FBO", test: (f) => Boolean(f.fbo) },
  { key: "rated", label: "Has comments", test: (f) => (f.rating?.n || 0) > 0 },
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
    if (state.approachTypes?.size && !hasApproachTypes(f, state.approachTypes)) continue;
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

export const hasContractMerchant = (f) => (f.aircard || []).some((m) => m.contract);

/**
 * Government fuel, from the AIR Card merchant export ("DLA Energy Contract"
 * = a GFC merchant; "Open Market" = accepts the AIR Card without a contract)
 * set against the nav info list's own notes. The list stays the authority on
 * whether crews are *approved* — when the two disagree both are shown.
 */
export function gfcStatus(f) {
  const merchants = f.aircard || [];
  const contract = merchants.filter((m) => m.contract);
  const openOnSite = merchants.filter((m) => !m.contract && m.onSite);
  const openOff = merchants.filter((m) => !m.contract && !m.onSite);
  const notes = f.notes || "";
  const listSaysNo = /\bno (gfc|fuel contract|government fuel)/i.test(notes) || /\bFBO lost GFC\b/i.test(notes);

  let level, text;
  if (contract.length) {
    level = "contract";
    text = `DLA contract: ${contract.map((m) => m.merchant).join(", ")}`;
  } else if (listSaysNo) {
    level = "none";
    text = "No GFC (per nav info list)";
  } else if (openOnSite.length) {
    level = "open";
    text = `AIR Card open market on-site: ${openOnSite.map((m) => m.merchant).join(", ")}`;
  } else if (openOff.length) {
    level = "delivered";
    text = "No on-site merchant; open-market suppliers deliver";
  } else {
    level = "unknown";
    text = "GFC not noted — verify before going";
  }
  const conflict = listSaysNo && contract.length > 0;
  return {
    level,
    text,
    // legacy fields the sheet colours by
    known: level !== "unknown",
    has: level === "contract" || level === "open" ? true : level === "none" ? false : null,
    conflict,
    conflictText: conflict ? "The nav info list says “No GFC” here, but AIR Card data shows a DLA contract merchant. Trust the list; verify before relying on it." : null,
    contract,
    openOnSite,
    openOff,
  };
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
