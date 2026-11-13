import { test } from "node:test";
import assert from "node:assert/strict";
import { ageHours, ageText, isStale, staleSources, staleMessage, MAX_AGE_HOURS } from "../../assets/js/planner/data-age.js";

const NOW = new Date("2026-11-11T12:00:00Z");
const ago = (h) => new Date(NOW - h * 3600000).toISOString();

test("ageHours: elapsed hours, null without a usable time, never negative", () => {
  assert.equal(ageHours(ago(5), NOW), 5);
  assert.equal(ageHours(null, NOW), null);
  assert.equal(ageHours(undefined, NOW), null);
  assert.equal(ageHours("not a date", NOW), null);
  assert.equal(ageHours(new Date(NOW.getTime() + 3600000).toISOString(), NOW), 0, "a clock that runs ahead is not a negative age");
});

test("ageText: minutes, hours, then days", () => {
  assert.equal(ageText(0.2), "12 minutes");
  assert.equal(ageText(0.001), "1 minute");
  assert.equal(ageText(1), "1 hour");
  assert.equal(ageText(5.4), "5 hours");
  assert.equal(ageText(47), "47 hours");
  assert.equal(ageText(72), "3 days");
});

test("isStale: each source has its own limit, and exactly at the limit is still fresh", () => {
  assert.equal(isStale("forecast", ago(MAX_AGE_HOURS.forecast), NOW), false);
  assert.equal(isStale("forecast", ago(MAX_AGE_HOURS.forecast + 0.1), NOW), true);
  assert.equal(isStale("tfr", ago(3), NOW), false, "a few hours' gap in GitHub's schedule is not an alarm");
  assert.equal(isStale("tfr", ago(5), NOW), true);
  assert.equal(isStale("notams", ago(25), NOW), false, "a daily file is not stale a day later");
  assert.equal(isStale("notams", ago(31), NOW), true);
  assert.equal(isStale("notams", null, NOW), false, "no file is 'not loaded', not 'stale'");
});

test("staleSources: only the stale ones, oldest first, with readable ages", () => {
  const list = staleSources({ forecast: ago(21), tfr: ago(1), notams: ago(60) }, NOW);
  assert.deepEqual(list.map((s) => [s.source, s.text]), [["notams", "3 days"], ["forecast", "21 hours"]]);
  assert.deepEqual(staleSources({ forecast: ago(1), tfr: ago(1), notams: ago(1) }, NOW), []);
  assert.deepEqual(staleSources({}, NOW), [], "nothing loaded yet");
  assert.deepEqual(staleSources(undefined, NOW), []);
});

test("staleMessage: names every stale source with the right verb", () => {
  assert.match(staleMessage(staleSources({ notams: ago(40) }, NOW)), /^NOTAMs is 40 hours old — a data refresh may have failed/);
  assert.match(staleMessage(staleSources({ tfr: ago(5) }, NOW)), /^TFRs are 5 hours old/);
  assert.match(staleMessage(staleSources({ tfr: ago(5) }, NOW)), /Check tfr\.faa\.gov and NOTAMs before you fly\.$/, "TFRs point at the FAA's page");
  assert.match(staleMessage(staleSources({ notams: ago(40) }, NOW)), /Check official sources before you fly\.$/);
  const two = staleMessage(staleSources({ forecast: ago(20), tfr: ago(5), notams: ago(40) }, NOW));
  assert.match(two, /^NOTAMs is 40 hours old, Forecast is 20 hours old and TFRs are 5 hours old — /);
});
