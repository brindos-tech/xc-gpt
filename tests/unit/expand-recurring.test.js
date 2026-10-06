import { test } from "node:test";
import assert from "node:assert/strict";
import { expandRecurring } from "../../scripts/expand-recurring.js";

const today = new Date(2026, 9, 6);
const occurrences = (rule, extra = {}) =>
  expandRecurring([{ id: "x", title: "X", placeId: "p", category: "fair", scale: "major", rule, ...extra }], { today });

test("nth weekday rules project into later years as estimates", () => {
  // 1st Saturday of October, 9 days (the Balloon Fiesta pattern)
  const evs = occurrences({ type: "nth-weekday-of-month", month: 10, weekday: 6, nth: 1, durationDays: 9 });
  const y2027 = evs.find((e) => e.start.startsWith("2027"));
  assert.equal(y2027.start, "2027-10-02");
  assert.equal(y2027.end, "2027-10-10");
  assert.equal(y2027.confidence, "annual-estimate");
});

test("offsetDays anchors to a holiday weekday", () => {
  // Friday after Labor Day (1st Monday of September), 10 days
  const evs = occurrences({ type: "nth-weekday-of-month", month: 9, weekday: 1, nth: 1, offsetDays: 4, durationDays: 10 });
  assert.equal(evs.find((e) => e.start.startsWith("2027")).start, "2027-09-10");
});

test("confirmed dates win and are read on the local calendar", () => {
  const evs = occurrences(
    { type: "nth-weekday-of-month", month: 10, weekday: 6, nth: 1, durationDays: 9 },
    { confirmed: { 2026: { start: "2026-10-03", end: "2026-10-11" } } }
  );
  const y2026 = evs.find((e) => e.start.startsWith("2026"));
  assert.deepEqual([y2026.start, y2026.end, y2026.confidence], ["2026-10-03", "2026-10-11", "confirmed"]);
});

test("a rule that can't be projected only appears in confirmed years", () => {
  const evs = occurrences({ type: "confirmed-only" }, { confirmed: { 2027: { start: "2027-02-05", end: "2027-02-09" } } });
  assert.deepEqual(evs.map((e) => e.start), ["2027-02-05"]);
});
