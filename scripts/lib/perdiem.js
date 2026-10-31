// GSA CONUS per diem: match an airfield's state + county (from FAA NASR) to
// a GSA non-standard area, falling back to the state's standard rate.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function normalizeCounty(s) {
  return (s || "")
    .toUpperCase()
    .replace(/\b(COUNTY|PARISH|BOROUGH|CITY OF|CITY)\b/g, "")
    .replace(/\bST\.?\s/g, "SAINT ")
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** GSA "County" can list several: "Fairfax / Arlington", "Bexar and Kendall". */
export function splitCounties(s) {
  return (s || "")
    .split(/\s*(?:\/|,|;|\band\b|&)\s*/i)
    .map(normalizeCounty)
    .filter(Boolean);
}

/** GSA conus/lodging rows -> lookup(state, county, city) -> { area, lodging[12], meals }. */
export function buildPerDiemIndex(rows) {
  const byState = new Map();
  for (const r of rows) {
    const st = (r.State || "").toUpperCase();
    if (!byState.has(st)) byState.set(st, []);
    byState.get(st).push({
      area: r.City,
      counties: splitCounties(r.County),
      city: normalizeCounty(r.City),
      lodging: MONTHS.map((m) => Number(r[m]) || null),
      meals: Number(r.Meals) || null,
      standard: /standard rate/i.test(r.City || ""),
    });
  }
  return function lookup(state, county, city) {
    const list = byState.get((state || "").toUpperCase()) || [];
    const c = normalizeCounty(county);
    const hit =
      list.find((x) => !x.standard && c && x.counties.includes(c)) ||
      list.find((x) => !x.standard && city && x.city === normalizeCounty(city)) ||
      list.find((x) => x.standard);
    if (!hit) return null;
    return { area: hit.standard ? "Standard rate" : hit.area, lodging: hit.lodging, meals: hit.meals };
  };
}

/** Federal fiscal year a date falls in (FY2027 = Oct 2026 – Sep 2027). */
export function fiscalYear(date) {
  return date.getMonth() >= 9 ? date.getFullYear() + 1 : date.getFullYear();
}
