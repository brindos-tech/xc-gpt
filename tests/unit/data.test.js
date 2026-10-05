// The committed data has to pass the same gate the refresh pipeline uses,
// so a hand edit to data/curated/*.json fails here, in review, instead of
// failing tomorrow's 06:00 refresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateDataset } from "../../scripts/lib/schema.js";

const read = (p) => JSON.parse(readFileSync(p, "utf-8"));

test("curated places and generated events validate", () => {
  const { ok, errors } = validateDataset({
    places: read("data/curated/places.json"),
    events: read("data/generated/events.json"),
    previousMeta: null,
  });
  assert.ok(ok, errors.slice(0, 10).join("\n"));
});

test("curated config references real values", () => {
  const config = read("data/curated/config.json");
  const ids = config.origins.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate origin id");
  for (const o of config.origins) assert.match(o.icao, /^K[A-Z0-9]{3}$/, o.id);
});

test("overrides point at curated places", () => {
  const placeIds = new Set(read("data/curated/places.json").map((p) => p.id));
  for (const [date, o] of Object.entries(read("data/curated/overrides.json"))) {
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(placeIds.has(o.placeId), `${date}: unknown place ${o.placeId}`);
  }
});

test("place ids are unique", () => {
  const ids = read("data/curated/places.json").map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});
