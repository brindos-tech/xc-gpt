import { test } from "node:test";
import assert from "node:assert/strict";
import { groupOf, isBigEvent, bigEventScore, upcomingWeekends, weekendCandidates, pickBackups, planWeekends } from "../../assets/js/weekends.js";
import { toDateKey, addDays } from "../../assets/js/format.js";

const scoring = { scaleWeight: { flagship: 10, major: 6, notable: 3, local: 1 }, favoriteArtistMultiplier: 2.5, proximityHalfLifeNm: 450, confidencePenalty: { confirmed: 1 }, rarityBoost: { annual: 1.4, recurring: 1 } };
const place = (id, distanceNm = 100) => ({ id, name: id, distanceNm, flightMinutes: 30 });
const ev = (id, category, start, placeId, extra = {}) => ({ id, title: id, category, start, end: start, placeId, scale: "notable", confidence: "confirmed", ...extra });

test("kinds and what counts as big", () => {
  assert.equal(groupOf({ category: "sports" }), "sports");
  assert.equal(groupOf({ category: "concert" }), "concert");
  for (const c of ["festival", "rodeo", "fair", "food", "holiday", "art"]) assert.equal(groupOf({ category: c }), "other");
  // sports: a pro/SEC team or a notable-scale game, not a small-college game
  assert.equal(isBigEvent({ category: "sports", title: "Dallas Cowboys vs. New York Giants", scale: "local" }), true);
  assert.equal(isBigEvent({ category: "sports", title: "Tiny College vs. Other College", scale: "local" }), false);
  assert.equal(isBigEvent({ category: "sports", title: "Big Bowl", scale: "major" }), true);
  // concerts: a favourite artist or arena scale
  assert.equal(isBigEvent({ category: "concert", title: "Open mic", scale: "local" }), false);
  assert.equal(isBigEvent({ category: "concert", title: "Tour", scale: "notable" }), true);
  assert.equal(isBigEvent({ category: "concert", title: "Club night", scale: "local", isFavoriteArtist: true }), true);
  // theatre/comedy noise in "art" is out unless it is big; low-volume kinds and hand-picked events are in; a PR chance always is
  assert.equal(isBigEvent({ category: "art", scale: "local" }), false);
  assert.equal(isBigEvent({ category: "art", scale: "notable" }), true);
  assert.equal(isBigEvent({ category: "rodeo", scale: "local" }), true);
  assert.equal(isBigEvent({ category: "sports", title: "Nobody", scale: "local", pr: true }), true);
  assert.equal(isBigEvent({ category: "concert", scale: "local", curated: true }), true);
  assert.equal(bigEventScore({ category: "concert", scale: "local" }, place("a"), scoring), 0);
  assert.ok(bigEventScore({ category: "rodeo", scale: "major" }, place("near", 0), scoring) > bigEventScore({ category: "rodeo", scale: "major" }, place("far", 900), scoring), "closer scores higher");
});

test("upcoming weekends: this one until Sunday ends, then the following Fridays", () => {
  const keys = (d, n) => upcomingWeekends(d, n).map((w) => toDateKey(w.friday));
  assert.deepEqual(keys(new Date(2026, 10, 2), 3), ["2026-11-06", "2026-11-13", "2026-11-20"]); // Monday
  assert.equal(keys(new Date(2026, 10, 6), 1)[0], "2026-11-06"); // Friday itself
  assert.equal(keys(new Date(2026, 10, 8), 1)[0], "2026-11-06"); // Sunday: still this weekend
  assert.equal(keys(new Date(2026, 10, 9), 1)[0], "2026-11-13"); // Monday after
  const w = upcomingWeekends(new Date(2026, 10, 2), 1)[0];
  assert.equal(toDateKey(w.sunday), "2026-11-08");
});

test("candidates: overlap the weekend, stay in range, best event per place and kind, long runs at half weight", () => {
  const w = upcomingWeekends(new Date(2026, 10, 2), 1)[0]; // Nov 6–8
  const places = new Map([["near", place("near", 50)], ["far", place("far", 900)]]);
  const events = [
    ev("sat-concert", "concert", "2026-11-07", "near", { scale: "major" }),
    ev("sat-concert-2", "concert", "2026-11-07", "near", { scale: "notable" }),
    ev("sports", "sports", "2026-11-08", "near", { title: "Dallas Cowboys vs. X" }),
    ev("too-far", "concert", "2026-11-07", "far", { scale: "flagship" }),
    ev("last-week", "concert", "2026-10-30", "near", { scale: "flagship" }),
    ev("long-fest", "festival", "2026-10-20", "near", { end: "2026-11-29", scale: "notable" }),
    ev("fresh-fest", "festival", "2026-11-07", "near", { end: "2026-11-07", scale: "notable", id: "fresh-fest" }),
  ];
  const c = weekendCandidates(w, events, places, scoring, 600);
  assert.ok(!c.some((x) => x.place.id === "far"), "out of range");
  assert.ok(!c.some((x) => x.event.id === "last-week"), "ended before the weekend");
  const concert = c.find((x) => x.group === "concert");
  assert.equal(concert.event.id, "sat-concert", "the major beats the notable");
  assert.deepEqual(concert.more.map((e) => e.id), ["sat-concert-2"]);
  const other = c.find((x) => x.group === "other");
  assert.equal(other.event.id, "fresh-fest", "something that happens this weekend beats a run already under way");
  assert.deepEqual(c.map((x) => x.score), [...c.map((x) => x.score)].sort((a, b) => b - a), "best first");
});

test("backups: other places, and other kinds when the weekend has them", () => {
  const mk = (id, group, score, pid) => ({ event: { id }, place: { id: pid }, group, score, more: [] });
  const primary = mk("p", "sports", 9, "A");
  const pool = [primary, mk("s2", "sports", 8, "B"), mk("c1", "concert", 5, "C"), mk("o1", "other", 4, "D"), mk("c2", "concert", 3, "E")];
  const b = pickBackups(primary, pool);
  assert.deepEqual(b.map((x) => x.event.id), ["c1", "o1"], "a concert and a big event, not another game");
  // same place never twice; fewer than two available is fine
  const thin = pickBackups(primary, [primary, mk("same", "concert", 9, "A")]);
  assert.deepEqual(thin, []);
  // a weight can push an overused event down
  const w = pickBackups(primary, pool, 2, (c) => (c.event.id === "c1" ? 0.01 : 1));
  assert.deepEqual(w.map((x) => x.event.id), ["o1", "c2"]);
});

test("planning: the primaries are a mix, not whichever kind scores highest", () => {
  const weekends = upcomingWeekends(new Date(2026, 10, 2), 6);
  const places = [place("A", 40), place("B", 60), place("C", 80)];
  const events = [];
  weekends.forEach((w, i) => {
    const sat = toDateKey(addDays(w.friday, 1));
    // sports is strong every weekend; concerts and other events are weaker but always present
    events.push(ev(`game-${i}`, "sports", sat, "A", { scale: "flagship", title: "Dallas Cowboys vs. X" }));
    events.push(ev(`tour-${i}`, "concert", sat, "B", { scale: "major" }));
    events.push(ev(`fest-${i}`, "festival", sat, "C", { scale: "notable" }));
  });
  const { rows, mix } = planWeekends({ weekends, events, places, scoring, rangeNm: 600 });
  assert.deepEqual(mix, { sports: 2, concert: 2, other: 2 }, "a third each");
  assert.equal(rows.filter((r) => r.primary).length, 6);
  // every weekend still has two backups, of the other two kinds
  for (const r of rows) {
    assert.equal(r.backups.length, 2);
    assert.deepEqual([r.primary.group, ...r.backups.map((b) => b.group)].sort(), ["concert", "other", "sports"]);
  }
  // rows come back in date order
  assert.deepEqual(rows.map((r) => toDateKey(r.friday)), weekends.map((w) => toDateKey(w.friday)));
});

test("planning: one long festival isn't the pick every week; weekends with nothing say so; scarce kinds don't block", () => {
  const weekends = upcomingWeekends(new Date(2026, 10, 2), 4);
  const places = [place("A", 40), place("B", 60)];
  const events = [
    ev("run", "festival", "2026-11-01", "A", { end: "2026-12-31", scale: "major", curated: true }),
    ev("game-2", "sports", toDateKey(addDays(weekends[1].friday, 1)), "B", { title: "Dallas Cowboys vs. X", scale: "notable" }),
  ];
  const { rows, mix } = planWeekends({ weekends, events, places, scoring, rangeNm: 600 });
  assert.equal(rows[1].primary.group === "sports" || rows[1].primary.event.id === "run", true);
  assert.equal(mix.concert, 0, "no concerts to pick, none forced");
  assert.equal(rows.filter((r) => r.primary).length, 4, "the festival still fills the other weekends");
  const empty = planWeekends({ weekends, events: [], places, scoring, rangeNm: 600 });
  assert.ok(empty.rows.every((r) => !r.primary && r.backups.length === 0));
});
