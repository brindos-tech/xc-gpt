import { test } from "node:test";
import assert from "node:assert/strict";
import { seatGeekCategory, scaleFromScore, mapSeatGeekEvent } from "../../scripts/lib/seatgeek-map.js";

const tax = (...pairs) => pairs.map(([id, name, parent_id]) => ({ id, name, parent_id }));

test("taxonomies map to our categories", () => {
  assert.equal(seatGeekCategory({ type: "concert", taxonomies: tax([2000000, "concert"]) }), "concert");
  assert.equal(seatGeekCategory({ type: "music_festival", taxonomies: tax([2000000, "concert"], [2010000, "music_festival", 2000000]) }), "festival");
  assert.equal(seatGeekCategory({ type: "mlb", taxonomies: tax([1000000, "sports"], [1010100, "mlb", 1000000]) }), "sports");
  assert.equal(seatGeekCategory({ type: "ncaa_football", taxonomies: tax([1000000, "sports"], [1030200, "ncaa_football", 1000000]) }), "sports");
  assert.equal(seatGeekCategory({ type: "rodeo", taxonomies: tax([1000000, "sports"], [1110000, "rodeo", 1000000]) }), "rodeo");
  assert.equal(seatGeekCategory({ type: "broadway_tickets_national", taxonomies: tax([3000000, "theater"]) }), "art");
  assert.equal(seatGeekCategory({ type: "comedy", taxonomies: tax([3000000, "theater"], [3060000, "comedy", 3000000]) }), "art");
});

test("parking is never an event", () => {
  assert.equal(seatGeekCategory({ type: "parking", taxonomies: tax([9000000, "parking"]) }), "misc");
});

test("title cues win, and anything unknown is misc and tallied", () => {
  assert.equal(seatGeekCategory({ title: "Wings Over Houston Airshow", type: "family" }), "outdoors");
  const unmapped = new Map();
  assert.equal(seatGeekCategory({ title: "A lecture", type: "literary", taxonomies: tax([7000000, "literary"]) }, unmapped), "misc");
  assert.deepEqual([...unmapped.keys()], ["literary"]);
});

test("popularity score sets a conservative scale", () => {
  assert.equal(scaleFromScore(0.9), "major");
  assert.equal(scaleFromScore(0.65), "notable");
  assert.equal(scaleFromScore(0.2), "local");
});

test("maps an event record", () => {
  const ev = mapSeatGeekEvent(
    {
      id: 123, title: "Zach Bryan", datetime_local: "2026-11-07T19:30:00", datetime_utc: "2026-11-08T01:30:00",
      url: "https://seatgeek.com/e/123", type: "concert", score: 0.85, taxonomies: tax([2000000, "concert"]),
      venue: { name: "Arena", location: { lat: 36.1, lon: -95.9 } }, performers: [{ name: "Zach Bryan" }],
    },
    "tulsa-ok"
  );
  assert.equal(ev.id, "sg-123");
  assert.equal(ev.start, "2026-11-07");
  assert.equal(ev.placeId, "tulsa-ok");
  assert.equal(ev.category, "concert");
  assert.equal(ev.scale, "major");
  assert.equal(ev.source, "seatgeek");
  assert.deepEqual(ev.performerNames, ["Zach Bryan"]);
});
