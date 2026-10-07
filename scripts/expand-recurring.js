#!/usr/bin/env node
// Expands data/curated/recurring.json into concrete event occurrences from
// (today - 1 month) to (today + 18 months). Confirmed years use the exact
// pinned dates (confidence: "confirmed"); everything else is projected from
// the rule and marked "annual-estimate" — never presented as fact.
//
// This logic is validated against known dates in a throwaway Python port
// during development (see ARCHITECTURE.md §Phase 1 checkpoint); keep this
// file and that validation in sync if the rule types change.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const CURATED_DIR = path.resolve("data/curated");
const CACHE_DIR = path.resolve(".cache");

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate(); // month is 1-indexed here
}

/** weekdayJs: 0=Sun..6=Sat. nth: 1-5 from start, or negative to count from end (-1 = last). */
function nthWeekdayOfMonth(year, month, weekdayJs, nth) {
  const dim = daysInMonth(year, month);
  const matches = [];
  for (let d = 1; d <= dim; d++) {
    const date = new Date(year, month - 1, d);
    if (date.getDay() === weekdayJs) matches.push(date);
  }
  if (matches.length === 0) return null;
  if (nth > 0) return matches[nth - 1] || null;
  const idx = matches.length + nth;
  return idx >= 0 && idx < matches.length ? matches[idx] : null;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function localDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function expandRule(rule, year) {
  switch (rule.type) {
    case "nth-weekday-of-month": {
      // offsetDays anchors to a holiday-style weekday: Labor Day is the 1st
      // Monday of September, so "the Friday after Labor Day" is
      // { month: 9, weekday: 1, nth: 1, offsetDays: 4 }.
      const anchor = nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.nth);
      if (!anchor) return null;
      const start = addDays(anchor, rule.offsetDays || 0);
      return { start, end: addDays(start, rule.durationDays - 1) };
    }
    case "fixed-month-day": {
      const dim = daysInMonth(year, rule.month);
      if (rule.day > dim) return null;
      const start = new Date(year, rule.month - 1, rule.day);
      return { start, end: addDays(start, (rule.durationDays || 1) - 1) };
    }
    case "month-span": {
      const start = new Date(year, rule.startMonth - 1, Math.min(1 + (rule.startWeek - 1) * 7, 28));
      const endYear = rule.endMonth >= rule.startMonth ? year : year + 1;
      const end = new Date(endYear, rule.endMonth - 1, Math.min(1 + (rule.endWeek - 1) * 7, 28));
      return { start, end };
    }
    case "weekends-in-month": {
      const first = new Date(year, rule.month - 1, 1);
      const offset = (5 - first.getDay() + 7) % 7; // Friday = 5
      const start = addDays(first, offset);
      const end = addDays(start, rule.weekendCount * 7 - 5);
      return { start, end };
    }
    default:
      return null;
  }
}

export function expandRecurring(recurring, { today = new Date(), horizonMonthsBack = 1, horizonMonthsForward = 18 } = {}) {
  const horizonStart = new Date(today);
  horizonStart.setMonth(horizonStart.getMonth() - horizonMonthsBack);
  const horizonEnd = new Date(today);
  horizonEnd.setMonth(horizonEnd.getMonth() + horizonMonthsForward);

  const startYear = horizonStart.getFullYear();
  const endYear = horizonEnd.getFullYear();

  const events = [];
  let counter = 0;

  for (const r of recurring) {
    for (let year = startYear; year <= endYear; year++) {
      const confirmed = r.confirmed && r.confirmed[String(year)];
      let start, end, confidence;

      if (confirmed) {
        // local-calendar parse: new Date("2026-08-15") is UTC midnight,
        // which toDateKey's local getters read as Aug 14 anywhere west of UTC
        start = localDate(confirmed.start);
        end = localDate(confirmed.end || confirmed.start);
        confidence = "confirmed";
      } else {
        const expanded = expandRule(r.rule, year);
        if (!expanded) continue;
        ({ start, end } = expanded);
        confidence = "annual-estimate";
      }

      if (end < horizonStart || start > horizonEnd) continue;

      counter++;
      events.push({
        id: `rec-${r.id}-${year}`,
        title: r.title,
        start: toDateKey(start),
        end: toDateKey(end),
        startTime: null,
        placeId: r.placeId,
        venue: null,
        category: r.category,
        subcategory: null,
        scale: r.scale,
        attendance: r.attendance ?? null,
        artistIds: [],
        isFavoriteArtist: false,
        description: r.description,
        url: r.url || "",
        ticketUrl: r.url || "",
        source: "recurring",
        sourceId: null,
        confidence,
        fetchedAt: new Date().toISOString(),
        recurringId: r.id,
      });
    }
  }

  return events;
}

async function main() {
  const recurring = JSON.parse(await readFile(path.join(CURATED_DIR, "recurring.json"), "utf-8"));
  const expanded = expandRecurring(recurring);

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, "recurring-expanded.json"), JSON.stringify(expanded, null, 2));

  console.log(`Expanded ${recurring.length} recurring rules -> ${expanded.length} occurrences.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
