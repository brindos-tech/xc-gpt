import { test } from "node:test";
import assert from "node:assert/strict";
import { prReason, prTitleReason, patrioticDates, buildVenueIndex, applyPrOverlays } from "../../scripts/lib/pr.js";

const game = (title, extra = {}) => ({ title, category: "sports", subcategory: "Football", start: "2026-10-03", ...extra });

test("air shows and military-themed titles", () => {
  assert.match(prTitleReason("Wings Over Houston Airshow"), /Air show/);
  assert.match(prTitleReason("EAA AirVenture Oshkosh"), /Air show/);
  assert.match(prTitleReason("Thunder Over Louisville"), /Air show/);
  assert.match(prTitleReason("Salute to Service: Chiefs vs. Broncos"), /Military/);
  assert.equal(prTitleReason("Wings of Desire"), null);
  assert.equal(prTitleReason("Chiefs vs. Broncos"), null);
});

test("military appreciation games say whether a flyover is possible", () => {
  assert.equal(prReason(game("Oklahoma State vs. Baylor — Military Appreciation Game")), "Military appreciation game");
  assert.match(prReason(game("OKC Thunder Military Appreciation Night", { subcategory: "Basketball" })), /indoor .* no flyover/);
});

test("bowl games and motorsport carry flyover traditions; Hollywood Bowl does not", () => {
  assert.match(prReason(game("2026 Goodyear Cotton Bowl Classic")), /Bowl game/);
  assert.match(prReason(game("NASCAR Cup Series at Texas Motor Speedway", { subcategory: "Motorsports/Racing" })), /Motorsport/);
  assert.equal(prReason({ title: "Hollywood Bowl: John Williams", category: "concert", start: "2026-10-03" }), null);
});

test("patriotic dates: Veterans Day weekend, Memorial Day weekend, July 4", () => {
  const d2026 = patrioticDates(2026);
  assert.equal(d2026.get("2026-11-11"), "Veterans Day");
  assert.equal(d2026.get("2026-11-07"), "Veterans Day weekend"); // Sat before Wed Nov 11
  assert.equal(d2026.get("2026-05-24"), "Memorial Day weekend");
  assert.equal(d2026.get("2026-07-04"), "Independence Day");
  assert.match(prReason(game("Chiefs vs. Broncos", { start: "2026-11-08" })), /Veterans Day weekend game/);
  // indoor games on the same dates don't get a flyover tag
  assert.equal(prReason(game("Mavericks vs. Spurs", { start: "2026-11-08", subcategory: "Basketball" })), null);
});

test("games at a venue that has hosted flyovers", () => {
  const venueMatch = buildVenueIndex([{ venue: "Boone Pickens Stadium", note: "Vance T-6s, 2023", aliases: [] }]);
  const ev = game("Oklahoma State Cowboys vs. Baylor Bears", { venue: { name: "Boone Pickens Stadium" } });
  assert.match(prReason(ev, { venueMatch }), /Boone Pickens Stadium \(Vance T-6s, 2023\)/);
  // a concert at the same stadium is not a flyover candidate
  assert.equal(prReason({ ...ev, category: "concert", subcategory: "Rock" }, { venueMatch }), null);
});

test("curated overlays tag matching events or add their own", () => {
  const events = [{ id: "a", title: "Dallas Cowboys vs. Eagles", placeId: "dallas-tx", start: "2026-11-15" }];
  const { added, tagged } = applyPrOverlays(events, [
    { id: "sts", placeId: "dallas-tx", start: "2026-11-15", match: "Cowboys", reason: "NFL Salute to Service game" },
    { id: "armed-forces-bowl", placeId: "fort-worth-tx", start: "2026-12-26", title: "Armed Forces Bowl", reason: "Military bowl game" },
  ]);
  assert.equal(tagged, 1);
  assert.equal(events[0].pr, "NFL Salute to Service game");
  assert.equal(added.length, 1);
  assert.equal(added[0].pr, "Military bowl game");
  assert.equal(added[0].source, "curated");
});

import { overlaysFromSchedule, MILITARY_PROMO } from "../../scripts/fetch-mlb-promotions.js";
import { mergeLeads, webQueries } from "../../scripts/fetch-pr-leads.js";

test("MLB/MiLB schedule promotions become PR overlays near curated places", () => {
  const places = [{ id: "tulsa-ok", lat: 36.154, lon: -95.993 }];
  const data = {
    dates: [{
      date: "2027-05-29",
      games: [
        {
          gamePk: 777, officialDate: "2027-05-29",
          teams: { home: { team: { name: "Tulsa Drillers", sport: { id: 12 } } }, away: { team: { name: "Arkansas Travelers" } } },
          venue: { name: "ONEOK Field", location: { defaultCoordinates: { latitude: 36.16, longitude: -95.99 } } },
          promotions: [{ name: "Military Appreciation Night" }, { name: "Fireworks" }],
        },
        {
          gamePk: 778, officialDate: "2027-05-30",
          teams: { home: { team: { name: "Tulsa Drillers" } }, away: { team: { name: "Arkansas Travelers" } } },
          venue: { location: { defaultCoordinates: { latitude: 36.16, longitude: -95.99 } } },
          promotions: [{ name: "Bark in the Park" }],
        },
      ],
    }],
  };
  const out = overlaysFromSchedule(data, places, "2027-01-01");
  assert.equal(out.length, 1);
  assert.equal(out[0].placeId, "tulsa-ok");
  assert.equal(out[0].match, "Drillers");
  assert.match(out[0].reason, /Military Appreciation Night at ONEOK Field/);
  assert.equal(out[0].scale, "notable");
  assert.equal(MILITARY_PROMO.test("Bark in the Park"), false);
});

test("leads accumulate, dedupe by URL and age out", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  const previous = [
    { url: "https://a", title: "A", foundAt: "2026-10-01T00:00:00Z" },
    { url: "https://old", title: "Old", foundAt: "2026-07-01T00:00:00Z" },
  ];
  const merged = mergeLeads(previous, [{ url: "https://a", title: "A again" }, { url: "https://b", title: "B" }], now);
  assert.deepEqual(merged.map((l) => l.url), ["https://b", "https://a"]);
  assert.equal(merged[1].title, "A");
  assert.ok(webQueries(2027).some((q) => q.includes("Oklahoma") && q.includes("military appreciation")));
});

test("hockey Thunderbirds and academy volleyball are not PR events; academy football is", () => {
  assert.equal(prReason(game("Seattle Thunderbirds vs. Kamloops Blazers", { subcategory: "Hockey" })), null);
  assert.match(prTitleReason("USAF Thunderbirds at Tinker Air Show"), /Air show/);
  assert.equal(prReason(game("Air Force Falcons at UTEP Miners Womens Volleyball", { subcategory: "Volleyball" })), null);
  assert.equal(prReason(game("Tulsa Golden Hurricane Football vs. Army Black Knights Football")), "Service academy football game");
});
