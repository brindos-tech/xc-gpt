// Pure helpers for the Reviews page: who a comment is about, and the rankings
// (top rated, perks) built from the API's /summary and /feed. No DOM.
import { typeName } from "./airspace.js";

/** "field:KOKC" / "airspace:MOA:VANCE 1A MOA" -> what to show and where "view on map" goes. */
export function subjectInfo(subject, fieldsByCode) {
  if (subject.startsWith("field:")) {
    const code = subject.slice(6);
    const f = fieldsByCode?.get(code);
    return { kind: "field", code, id: code, title: f ? `${code} · ${f.name}` : code, sub: f ? [f.fbo, f.city].filter(Boolean).join(" · ") : "", known: Boolean(f) };
  }
  const id = subject.slice("airspace:".length);
  const [type, ...rest] = id.split(":");
  return { kind: "air", id, title: rest.join(":") || id, sub: typeName(type), known: true };
}

/** A damped average so one 5-star review doesn't outrank a field with ten 4.8s. */
export const rankScore = (avg, n, prior = 3.5, weight = 2) => (avg * n + prior * weight) / (n + weight);

const PERK_FIELD = { food: "freeFood", car: "crewCar", card: "aircard" };
export const PERKS = { food: "Free food", car: "Crew car", card: "AIR Card accepted" };

/**
 * Ranked rows from the summary.
 * @param {Record<string, {n:number, avg:number|null, perks?:object}>} summary
 * @param {{sort:"top"|"food"|"car"|"card", type:"all"|"field"|"air", q?:string}} opts
 */
export function rankSubjects(summary, fieldsByCode, { sort = "top", type = "all", q = "" }) {
  const needle = q.trim().toLowerCase();
  const rows = [];
  for (const [subject, s] of Object.entries(summary || {})) {
    const info = subjectInfo(subject, fieldsByCode);
    if (type === "field" && info.kind !== "field") continue;
    if (type === "air" && info.kind !== "air") continue;
    if (needle && !`${info.title} ${info.sub}`.toLowerCase().includes(needle)) continue;
    const perks = s.perks || { food: [0, 0], car: [0, 0], card: [0, 0] };
    if (sort === "top") {
      if (s.avg == null) continue;
      rows.push({ subject, info, ...s, perks, score: rankScore(s.avg, s.n) });
    } else {
      const [yes, no] = perks[sort] || [0, 0];
      if (!yes) continue;
      rows.push({ subject, info, ...s, perks, score: yes - no + yes / 100 });
    }
  }
  rows.sort((a, b) => b.score - a.score || b.n - a.n || a.info.title.localeCompare(b.info.title));
  return rows;
}

/** Recent comments filtered by subject type and a text search. */
export function filterFeed(feed, fieldsByCode, { type = "all", q = "" }) {
  const needle = q.trim().toLowerCase();
  return (feed || []).filter((c) => {
    const info = subjectInfo(c.subject, fieldsByCode);
    if (type === "field" && info.kind !== "field") return false;
    if (type === "air" && info.kind !== "air") return false;
    return !needle || `${info.title} ${info.sub} ${c.name} ${c.notes} ${c.fees} ${c.amenities} ${c.planespotters}`.toLowerCase().includes(needle);
  });
}

export { PERK_FIELD };
