import { test } from "node:test";
import assert from "node:assert/strict";
import { isAddOnListing } from "../../scripts/lib/noise.js";

test("add-on listings are recognised", () => {
  for (const title of [
    "Ohio State Football Single Game Parking",
    "Eagles - Suite Reservation",
    "Little Big Town - Suite Rental",
    "Day at the Races - Suites",
    "Jonas Brothers | Official BJCC Ticket + Hotel Packages",
    "CeCe Winans Official BJCC Ticket+ Hotel Packages",
    "Syd - Early Entry VIP Upgrade",
    "Wizards VIP Packages: 10/10/2026 (Preseason)",
    "Indianapolis Colts VIP Tailgate",
    "UCLA Bruins Football vs. USC Trojans - Premium Seating",
    "Broadway In Boise 2026-2027 Season Ticket Packages",
    "Seattle Seahawks Season Ticket Notification List",
  ]) {
    assert.equal(isAddOnListing(title), true, title);
  }
});

test("real events that merely share a word are kept", () => {
  for (const title of [
    "The Nutcracker Suite",
    "Hotel California - A Salute to the Eagles",
    "Halloween Hotel Takeover",
    "Banana Ball Playoffs Texas: Tailgaters vs. Loco Beach Coconuts",
    "Kansas City Chiefs vs. Las Vegas Raiders",
    "VIP",
  ]) {
    assert.equal(isAddOnListing(title), false, title);
  }
});
