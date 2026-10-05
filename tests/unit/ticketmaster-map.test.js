import { test } from "node:test";
import assert from "node:assert/strict";
import { categorize } from "../../scripts/lib/ticketmaster-map.js";

test("segments map regardless of punctuation and spacing", () => {
  assert.equal(categorize({ segment: "Music", genre: "Rock" }), "concert");
  assert.equal(categorize({ segment: "Sports", genre: "Football" }), "sports");
  assert.equal(categorize({ segment: "Arts & Theatre", genre: "Theatre" }), "art");
  assert.equal(categorize({ segment: "Arts&Theater" }), "art");
});

test("genre names one of our own categories", () => {
  assert.equal(categorize({ segment: "Sports", genre: "Rodeo" }), "rodeo");
  assert.equal(categorize({ segment: "Miscellaneous", genre: "Food & Drink" }), "food");
  assert.equal(categorize({ segment: "Miscellaneous", genre: "Fairs & Festivals" }), "festival");
  assert.equal(categorize({ segment: "Miscellaneous", genre: "Holiday" }), "holiday");
});

test("title cues catch what the taxonomy misses", () => {
  assert.equal(categorize({ segment: "Miscellaneous", genre: "Miscellaneous", title: "Wings Over Houston Airshow" }), "outdoors");
  assert.equal(categorize({ segment: "Miscellaneous", title: "Spring Fly-In" }), "outdoors");
  assert.equal(categorize({ segment: "Miscellaneous", title: "Smokin' BBQ Cook-Off" }), "food");
});

test("anything unmapped is misc and is tallied", () => {
  const unmapped = new Map();
  assert.equal(categorize({ segment: "Miscellaneous", genre: "Lecture/Seminar", title: "A talk" }, unmapped), "misc");
  assert.equal(categorize({ title: "Mystery" }, unmapped), "misc");
  assert.deepEqual([...unmapped.keys()], ["Miscellaneous / Lecture/Seminar", "(no segment) / (no genre)"]);
});
