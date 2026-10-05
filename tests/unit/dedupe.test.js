import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeEvents, isDuplicate } from "../../scripts/lib/dedupe.js";

const tm = (id, title, start, extra = {}) => ({
  id, title, start, end: start, placeId: "phoenix-az", source: "ticketmaster",
  category: "art", scale: "local", confidence: "confirmed", url: `https://x/${id}`, ...extra,
});

test("a run of nightly performances folds into one event spanning the run", () => {
  const { events } = dedupeEvents([
    tm("c", "Hadestown (Touring)", "2026-12-06"),
    tm("a", "Hadestown (Touring)", "2026-12-04"),
    tm("b", "Hadestown (Touring)", "2026-12-05"),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].start, "2026-12-04");
  assert.equal(events[0].end, "2026-12-06");
});

test("two showings on the same day collapse to one", () => {
  const { events } = dedupeEvents([tm("a", "British Invasion", "2026-10-24"), tm("b", "British Invasion", "2026-10-24")]);
  assert.equal(events.length, 1);
});

test("different Ticketmaster matchups on consecutive nights stay separate", () => {
  const { events } = dedupeEvents([
    tm("a", "Kansas City Royals vs. Detroit Tigers", "2026-09-01", { category: "sports" }),
    tm("b", "Kansas City Royals vs. Minnesota Twins", "2026-09-02", { category: "sports" }),
  ]);
  assert.equal(events.length, 2);
});

test("the same show a week apart is two events", () => {
  const { events } = dedupeEvents([tm("a", "Chris Estrada", "2026-10-03"), tm("b", "Chris Estrada", "2026-10-10")]);
  assert.equal(events.length, 2);
});

test("a curated festival keeps its full span when Ticketmaster lists one day of it", () => {
  const curated = {
    id: "seed-1", title: "Ozark Folk Festival", start: "2026-09-03", end: "2026-09-05", placeId: "phoenix-az",
    source: "curated", category: "festival", scale: "notable", confidence: "confirmed", description: "Hand-written", url: "",
  };
  const { events } = dedupeEvents([curated, tm("t", "Ozark Folk Festival", "2026-09-04")]);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "seed-1");
  assert.equal(events[0].start, "2026-09-03");
  assert.equal(events[0].end, "2026-09-05");
  assert.equal(events[0].description, "Hand-written");
  assert.equal(events[0].url, "https://x/t");
});

test("fuzzy title matching still reconciles different sources", () => {
  const a = { title: "Albuquerque International Balloon Fiesta", start: "2026-10-03", placeId: "p", source: "recurring" };
  const b = { title: "Albuquerque Intl Balloon Fiesta 2026", start: "2026-10-04", placeId: "p", source: "ticketmaster" };
  assert.equal(isDuplicate(a, b), true);
});

test("events at different places never merge", () => {
  const { events } = dedupeEvents([tm("a", "Annie", "2026-10-01"), tm("b", "Annie", "2026-10-01", { placeId: "tucson-az" })]);
  assert.equal(events.length, 2);
});
