import { test } from "node:test";
import assert from "node:assert/strict";
import { outlookForDays } from "../../assets/js/weather.js";

const weather = {
  dates: ["2026-10-09", "2026-10-10", "2026-10-11"],
  tempMax: [71.4, 40.2, 80],
  tempMin: [48, 31, 60],
  precipProbability: [5, 60, 30],
  weatherCode: [0, 71, 95],
};

test("reads the requested days and flags icing and storms", () => {
  const days = outlookForDays(weather, ["2026-10-09", "2026-10-10", "2026-10-11"]);
  assert.deepEqual(days.map((d) => d.hi), [71, 40, 80]);
  assert.deepEqual(days.map((d) => d.icing), [false, true, false]);
  assert.deepEqual(days.map((d) => d.thunder), [false, false, true]);
  assert.equal(days[0].dow, "Fri");
});

test("days past the forecast horizon are skipped, not guessed", () => {
  assert.equal(outlookForDays(weather, ["2026-10-11", "2026-10-12"]).length, 1);
  assert.deepEqual(outlookForDays(weather, ["2026-11-01"]), []);
  assert.deepEqual(outlookForDays(undefined, ["2026-10-09"]), []);
});
