import { test } from "node:test";
import assert from "node:assert/strict";
import { toClientEvent, isUpcoming, todayKey } from "../../scripts/lib/client-events.js";

const full = {
  id: "tm-1", title: "Show", start: "2026-10-10", end: "2026-10-10", startTime: "2026-10-11T01:00:00Z",
  placeId: "denver-co", venue: { name: "Ball Arena" }, category: "concert", subcategory: "Rock", scale: "local",
  attendance: null, artistIds: [], isFavoriteArtist: false, description: "Box office opens 2 hours before...",
  url: "https://tm/1", ticketUrl: "https://tm/1", source: "ticketmaster", sourceId: "1", confidence: "confirmed",
  fetchedAt: "2026-10-05T00:00:00Z", recurringId: null,
};

test("drops fields the page never reads and defaults it can infer", () => {
  assert.deepEqual(toClientEvent(full), {
    id: "tm-1", title: "Show", start: "2026-10-10", placeId: "denver-co",
    category: "concert", scale: "local", confidence: "confirmed", url: "https://tm/1",
  });
});

test("keeps what carries meaning", () => {
  const out = toClientEvent({
    ...full, source: "curated", end: "2026-10-12", artistIds: ["a1"], isFavoriteArtist: true,
    recurringId: "fest", description: "Hand-written", url: "", ticketUrl: "https://tix/1",
  });
  assert.equal(out.end, "2026-10-12");
  assert.deepEqual(out.artistIds, ["a1"]);
  assert.equal(out.isFavoriteArtist, true);
  assert.equal(out.recurringId, "fest");
  assert.equal(out.description, "Hand-written");
  assert.equal(out.url, "https://tix/1");
});

test("an event stays until its last day has passed", () => {
  assert.equal(isUpcoming({ start: "2026-10-03", end: "2026-10-11" }, "2026-10-05"), true);
  assert.equal(isUpcoming({ start: "2026-10-05" }, "2026-10-05"), true);
  assert.equal(isUpcoming({ start: "2026-10-04" }, "2026-10-05"), false);
});

test("todayKey uses the local calendar date", () => {
  assert.equal(todayKey(new Date(2026, 0, 9, 23, 59)), "2026-01-09");
});
