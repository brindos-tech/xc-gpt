// Weekend Recs: for each upcoming Fri–Sun, one best pick and two backups
// within range — chosen so the picks across the weekends are a MIX of
// sports, concerts and other big events (festivals, rodeos, fairs, air shows…)
// rather than whichever category happens to have the biggest scores.
// Pure functions: no DOM, no fetching.
import { addDays, fridayOf, parseDate, toDateKey } from "./format.js";
import { isProOrSecSportsEvent } from "./importance.js";

export const GROUP_LABELS = { sports: "Sports", concert: "Concert", other: "Big event" };
export const GROUPS = Object.keys(GROUP_LABELS);

/** sports | concert | other (festivals, rodeos, fairs, food, holidays, art, outdoors). */
export const groupOf = (ev) => (ev.category === "sports" ? "sports" : ev.category === "concert" ? "concert" : "other");

const BIG_SCALES = new Set(["notable", "major", "flagship"]);

/**
 * Worth flying for. Ticketmaster/SeatGeek lists everything down to club
 * nights, so "big" is judged per kind: a pro or SEC game (or a PR
 * opportunity), a favourite artist or an arena-scale concert, anything
 * hand-picked, and the low-volume categories (festival, rodeo, fair, food,
 * holiday, outdoors) — but not the local theatre/comedy noise in "art".
 */
export function isBigEvent(ev) {
  if (ev.pr) return true;
  if (ev.curated) return true;
  switch (ev.category) {
    case "sports":
      return isProOrSecSportsEvent(ev.title) || BIG_SCALES.has(ev.scale);
    case "concert":
      return Boolean(ev.isFavoriteArtist) || BIG_SCALES.has(ev.scale);
    case "art":
      return BIG_SCALES.has(ev.scale);
    default:
      return true; // festival, rodeo, fair, food, holiday, outdoors, misc
  }
}

/** How good a reason to go the event is, from the place it's at. 0 when it isn't big. */
export function bigEventScore(ev, place, scoring) {
  if (!isBigEvent(ev)) return 0;
  const scaleW = scoring.scaleWeight[ev.scale] ?? 1;
  const fav = ev.isFavoriteArtist ? scoring.favoriteArtistMultiplier : 1;
  const proximity = Math.pow(2, -(place?.distanceNm ?? 0) / scoring.proximityHalfLifeNm);
  const conf = scoring.confidencePenalty[ev.confidence] ?? 1;
  const rarity = ev.recurringId ? scoring.rarityBoost.annual : scoring.rarityBoost.recurring;
  const extras = (ev.pr ? 1.6 : 1) * (ev.curated ? 1.4 : 1) * (ev.category === "sports" && isProOrSecSportsEvent(ev.title) ? 1.3 : 1);
  return scaleW * fav * proximity * conf * rarity * extras;
}

/** The next `count` Fri–Sun weekends: this one while it is still going (through Sunday), then each following one. */
export function upcomingWeekends(today, count = 12) {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let friday = fridayOf(base);
  if (addDays(friday, 2) < base) friday = addDays(friday, 7);
  return Array.from({ length: count }, (_, i) => {
    const f = addDays(friday, 7 * i);
    return { friday: f, sunday: addDays(f, 2) };
  });
}

const CONTINUING_WEIGHT = 0.5;

/**
 * One candidate per (place, group) for the weekend — that place's best event
 * of that kind, with the rest of what's on there as `more` — sorted best first.
 * Events already under way before the Friday count at half weight, so the
 * later weekends of a long run don't crowd out something that only happens this weekend.
 */
export function weekendCandidates({ friday, sunday }, events, placesById, scoring, rangeNm) {
  const best = new Map(); // `${placeId}|${group}` -> candidate
  for (const ev of events) {
    const start = parseDate(ev.start);
    const end = parseDate(ev.end || ev.start);
    if (start > sunday || end < friday) continue;
    const place = placesById.get(ev.placeId);
    if (!place || place.distanceNm > rangeNm) continue;
    const base = bigEventScore(ev, place, scoring);
    if (base <= 0) continue;
    const score = base * (start < friday ? CONTINUING_WEIGHT : 1);
    const group = groupOf(ev);
    const key = `${ev.placeId}|${group}`;
    const cur = best.get(key);
    if (!cur) best.set(key, { event: ev, place, group, score, more: [] });
    else if (score > cur.score) {
      cur.more.unshift(cur.event);
      Object.assign(cur, { event: ev, score });
    } else cur.more.push(ev);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.place.name.localeCompare(b.place.name));
}

/**
 * Two backups for a weekend: different places from the pick, and as varied in
 * kind as the weekend allows (a sports pick gets a concert and a big event as
 * backups when those exist). `weight(candidate)` discounts events that are
 * already used elsewhere so the same thing isn't offered every week.
 */
export function pickBackups(primary, candidates, count = 2, weight = () => 1) {
  const used = new Set([primary.place.id]);
  const groupsUsed = new Set([primary.group]);
  const out = [];
  const pool = candidates.filter((c) => c !== primary).sort((a, b) => b.score * weight(b) - a.score * weight(a));
  while (out.length < count) {
    const fresh = pool.find((c) => !used.has(c.place.id) && !groupsUsed.has(c.group));
    const next = fresh || pool.find((c) => !used.has(c.place.id));
    if (!next) break;
    out.push(next);
    used.add(next.place.id);
    groupsUsed.add(next.group);
    pool.splice(pool.indexOf(next), 1);
  }
  return out;
}

const SPREAD = 0.7; // discount per pick a group already has
const eventKey = (ev) => ev.recurringId || ev.id || ev.title;

/**
 * Plan every weekend so the primaries are a MIX of sports, concerts and other
 * big events instead of all of one.
 *  1. Each kind is guaranteed a share (a third of the weekends, rounded down)
 *     where it has something: scarcest kinds first, each taking the weekends
 *     where it competes best with what else is on.
 *  2. The remaining weekends take the best remaining pick, discounted by how
 *     many picks its kind already has and capped at a third (rounded up) while
 *     another kind still has something.
 * Each event (or series) is offered once across all the weekends, as a pick or a backup: a light show
 * that runs all December is recommended one weekend, and the other weekends get that city's next best
 * thing of the same kind instead. It repeats only on a weekend with nothing else at all.
 * Returns the weekends in date order.
 */
export function planWeekends({ weekends, events, places, scoring, rangeNm }) {
  const placesById = new Map(places.map((p) => [p.id, p]));
  const rows = weekends.map((w) => ({ ...w, candidates: weekendCandidates(w, events, placesById, scoring, rangeNm), primary: null, backups: [] }));
  const live = rows.filter((r) => r.candidates.length);
  const counts = Object.fromEntries(GROUPS.map((g) => [g, 0]));
  const used = new Set(); // event keys already offered somewhere (pick or backup)
  const value = (c) => c.score / (1 + SPREAD * counts[c.group]);
  // the candidate as it would be offered now: its own event, or else the place's next event of that kind not yet used
  const fresh = (c, row) => {
    if (!used.has(eventKey(c.event))) return c;
    const alt = c.more.find((ev) => !used.has(eventKey(ev)));
    if (!alt) return null;
    const start = parseDate(alt.start);
    const score = bigEventScore(alt, c.place, scoring) * (start < row.friday ? CONTINUING_WEIGHT : 1);
    return { ...c, event: alt, score, more: c.more.filter((ev) => ev !== alt).concat(c.event) };
  };
  const freshList = (list, row) => {
    const out = list.map((c) => fresh(c, row)).filter(Boolean);
    return out.length ? out : list; // nothing new anywhere this weekend: a repeat beats an empty weekend
  };
  const best = (list) => list.reduce((b, c) => (value(c) > value(b) ? c : b), list[0]);
  const assign = (row, cand) => {
    row.primary = cand;
    counts[cand.group]++;
    used.add(eventKey(cand.event));
  };

  // 1. guaranteed shares
  const share = Math.floor(live.length / GROUPS.length);
  const weekendsWith = (g) => live.filter((r) => r.candidates.some((c) => c.group === g));
  const scarcest = [...GROUPS].sort((a, b) => weekendsWith(a).length - weekendsWith(b).length);
  for (const g of scarcest) {
    const strength = (r) => {
      const mine = r.candidates.filter((c) => c.group === g);
      return best(mine).score / r.candidates[0].score;
    };
    const open = weekendsWith(g).filter((r) => !r.primary).sort((a, b) => strength(b) - strength(a) || b.candidates[0].score - a.candidates[0].score);
    for (const row of open.slice(0, Math.max(0, share - counts[g]))) {
      const mine = freshList(row.candidates.filter((c) => c.group === g), row);
      assign(row, best(mine));
    }
  }

  // 2. everything else: best remaining pick, no kind over a third while another has something
  const cap = Math.ceil(live.length / GROUPS.length);
  const rest = live.filter((r) => !r.primary).sort((a, b) => b.candidates[0].score - a.candidates[0].score);
  for (const row of rest) {
    const all = freshList(row.candidates, row);
    const open = all.filter((c) => counts[c.group] < cap);
    assign(row, best(open.length ? open : all));
  }

  // backups, in date order, only from what has not been offered anywhere yet: one backup (or none) beats a repeat
  for (const row of rows) {
    if (!row.primary) continue;
    const others = row.candidates.filter((c) => c.place.id !== row.primary.place.id || c.group !== row.primary.group);
    const unused = others.map((c) => fresh(c, row)).filter(Boolean);
    row.backups = pickBackups(row.primary, unused, 2);
    for (const b of row.backups) used.add(eventKey(b.event));
  }
  return { rows, mix: counts };
}

export const weekendKey = (w) => toDateKey(w.friday);
