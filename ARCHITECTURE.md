# XC GPT — Architecture Specification

**Version:** 2.0 (rolling awareness engine)
**Author:** Architecture spec for implementation
**Date:** 2026-08-10
**Status:** Ready for implementation

---

## 0. What changed and why

**v1 (current, live)** is a single 96KB `index.html` — a hand-authored catalog of a fixed 19-weekend
season (Aug 15 – Dec 20, 2026). All content is pre-rendered prose. Distances are authored strings
(`"393 nm / ~1h19m"`). Events exist as sentences inside three different card types. The season end
date is baked in.

**v2 is a rolling situational-awareness engine.** Its job is to answer, at any moment:

> *What is going on around us, and where should we go?*

Not "what did we decide in August 2026." The site must be as useful in March 2027 as it is today,
with no hand-editing.

Three architectural changes make that possible, and everything else follows from them:

| # | Change | Unlocks |
|---|--------|---------|
| 1 | **Events become first-class normalized data** — not prose inside city cards | Filtering, sorting, date-windowing, density histograms, the entire feed |
| 2 | **Distance is computed, never authored** — store `lat`/`lon`, derive nm and flight time at runtime | The range slider, the Mississippi toggle, the fuel-stop logic |
| 3 | **A scheduled build plane regenerates data** — GitHub Actions writes JSON, Pages serves it | "Rolling with daily updates," without a server |

**Non-goal:** this is not a booking or checklist tool. No budgets, no reservation tracking, no
go/no-go cards. Awareness and discovery only.

---

## 1. System overview

Two planes that never talk to each other directly — they communicate only through committed JSON.

```
┌─────────────────────── BUILD PLANE (GitHub Actions, scheduled) ──────────────────────┐
│                                                                                       │
│  Ticketmaster API ─┐                                                                  │
│  Spotify API ──────┤                                                                  │
│  Open-Meteo API ───┼──► fetch ──► normalize ──► merge+dedupe ──► validate ──► commit  │
│  curated/*.json ───┘                                              │                   │
│                                                              (fail → keep last-good,  │
│                                                               open GitHub issue)      │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │  data/generated/*.json
                                            ▼
┌─────────────────────── RUNTIME PLANE (static, GitHub Pages) ─────────────────────────┐
│                                                                                       │
│  load JSON ──► derive (distance, legs, side-of-river) ──► filter pipeline ──► views   │
│                                                                │                      │
│                                            ┌───────────────────┼──────────────┐       │
│                                            ▼         ▼         ▼      ▼       ▼       │
│                                          Map      Feed     Places  Artists  Weekends  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### Hard rules

1. **No API keys in the browser. Ever.** The runtime plane makes exactly one class of external
   request: map tiles. Every other byte comes from same-origin JSON.
2. **The build plane never writes to `data/curated/`.** Curated files are human-authored and are the
   source of truth for anything a human decided.
3. **The runtime plane never writes to `data/generated/`.** It is read-only at runtime.
4. **A failed fetch must never degrade the site.** Validation gates the commit; last-good data stays
   live.
5. **All views render from one filter output.** Map, feed, and lists consume the same
   `{visiblePlaces, visibleEvents}` object. This is what keeps them from drifting out of sync.

---

## 2. Repository layout

```
enid-weekend-flight-plan/
├── index.html                      # shell only — no data, no content
├── ARCHITECTURE.md                 # this file
├── package.json                    # { "type": "module" }, dev deps for scripts only
│
├── assets/
│   ├── css/
│   │   ├── tokens.css              # design tokens (see §8)
│   │   ├── base.css
│   │   ├── layout.css              # app shell, rail, panel, responsive breakpoints
│   │   ├── components.css
│   │   └── map.css
│   └── js/
│       ├── main.js                 # bootstrap: load data → derive → mount views
│       ├── store.js                # state container + subscribe/notify
│       ├── filters.js              # PURE filter pipeline (§6)
│       ├── geo.js                  # SHARED with build plane — see note below
│       ├── score.js                # relevance scoring (§7)
│       ├── format.js               # nm→time, date humanizing, entity decoding
│       ├── url-state.js            # state ⇄ location.hash
│       └── views/
│           ├── map-view.js
│           ├── scrubber.js         # date brush + event-density histogram
│           ├── filter-rail.js      # range slider, west toggle, category chips
│           ├── feed-view.js
│           ├── places-view.js
│           ├── artists-view.js
│           ├── weekends-view.js
│           └── detail-panel.js
│
├── data/
│   ├── curated/                    # HUMAN-EDITED. Committed by hand. Source of truth.
│   │   ├── config.json             # origin, aircraft, defaults, scoring weights
│   │   ├── places.json             # destinations + airports
│   │   ├── artists.json            # favorite artists (Spotify-synced + manual)
│   │   ├── events.seed.json        # one-off events APIs don't cover
│   │   ├── recurring.json          # annual events as recurrence rules  ← makes it rolling
│   │   └── overrides.json          # manual weekend picks that beat the algorithm
│   │
│   └── generated/                  # CI-WRITTEN. Never hand-edit.
│       ├── events.json             # merged, deduped, normalized event corpus
│       ├── places.enriched.json    # places + rolling event counts
│       ├── weather.json            # 16-day outlook per place
│       └── meta.json               # build id, timestamps, source health  ← always written
│
├── scripts/                        # Node, ESM, zero runtime deps where possible
│   ├── lib/
│   │   ├── http.js                 # fetch w/ retry, backoff, rate limiting
│   │   ├── dedupe.js
│   │   ├── schema.js               # validators (§9.4)
│   │   └── entities.js             # HTML-entity decode for legacy migration
│   ├── fetch-ticketmaster.js
│   ├── fetch-spotify.js
│   ├── fetch-weather.js
│   ├── expand-recurring.js
│   ├── merge.js
│   ├── validate.js
│   ├── spotify-auth.js             # LOCAL one-shot re-auth helper (§9.3)
│   └── migrate-legacy.js           # ONE-TIME: v1 index.html → curated JSON (§11)
│
└── .github/workflows/
    ├── refresh-daily.yml
    └── refresh-weekly.yml
```

> **`geo.js` is imported by both planes.** Write it as a dependency-free ES module with named
> exports and no DOM/Node globals. `package.json` must set `"type": "module"` so Node can import it
> directly. This guarantees the distance the CI computes and the distance the browser computes are
> identical — do not duplicate this math.

**No build step for the site.** `index.html` loads ES modules directly. GitHub Pages serves the repo
as-is. CI builds *data*, not the app. This keeps deployment trivial and the site inspectable.

---

## 3. Data model

### 3.1 Place

A destination. Replaces v1's four parallel arrays (`cities`, `boutiqueCities`, `funFlights`,
`luxuryDestinations`) with one type carrying a `kinds` array — those four lists were never disjoint
(Santa Fe and Austin appear in two each), and the parallel-array-plus-parallel-coords pattern in v1
is a correctness hazard.

```json
{
  "id": "santa-fe-nm",
  "name": "Santa Fe",
  "state": "NM",
  "lat": 35.687,
  "lon": -105.938,
  "kinds": ["city", "luxury"],
  "activities": {
    "live-music": 3,
    "art": 5,
    "food": 5,
    "nightlife": 2,
    "outdoors": 4,
    "weird": 3
  },
  "blurb": "Adobe galleries, Canyon Road, world-class Southwestern food…",
  "airports": [
    {
      "icao": "KSAF",
      "name": "Santa Fe Municipal",
      "lat": 35.617,
      "lon": -106.089,
      "driveMiles": 9,
      "driveMinutes": 15,
      "vanceApproved": true,
      "military": false,
      "pprRequired": false,
      "notes": ""
    }
  ],
  "links": { "visit": "https://…" }
}
```

**Notes for the implementer:**

- `activities` is a **0–5 score per activity**, not a flat tag list. v1's single global 1–20 ranking
  can't answer "best food" and "best outdoors" differently. This is what powers §7.2.
- `driveMiles` / `driveMinutes` must be **structured fields**, not buried in prose. v1 hides
  "Marfa is a 195mi drive from KMAF" and "Fredericksburg is 78mi from KAUS" inside airport strings.
  Surface these — a 195-mile drive is a bigger factor than 30 minutes of flight time.
- `military` / `pprRequired` are flags, not footnotes. KOFF (Offutt AFB) appears twice in v1 with
  "no civilian FBO" as a parenthetical.
- **No distance or flight-time fields.** Both are derived. See §5.

### 3.2 Event

```json
{
  "id": "tm-G5vYZ9a7bK2",
  "title": "Zach Bryan — The Quittin Time Tour",
  "start": "2026-09-12",
  "end": "2026-09-12",
  "startTime": "2026-09-12T20:00:00-05:00",
  "placeId": "kansas-city-mo",
  "venue": { "name": "T-Mobile Center", "lat": 39.098, "lon": -94.580 },
  "category": "concert",
  "subcategory": "americana",
  "scale": "flagship",
  "attendance": 18000,
  "artistIds": ["zach-bryan"],
  "isFavoriteArtist": true,
  "description": "…",
  "url": "https://…",
  "ticketUrl": "https://…",
  "source": "ticketmaster",
  "sourceId": "G5vYZ9a7bK2",
  "confidence": "confirmed",
  "fetchedAt": "2026-08-10T06:00:00Z",
  "recurringId": null
}
```

**Enums** (fix these; do not invent values at runtime):

- `category`: `concert` · `festival` · `rodeo` · `fair` · `sports` · `art` · `food` · `outdoors` · `holiday` · `misc`
- `scale`: `flagship` (100K+ / national draw) · `major` (10K+) · `notable` (1K+) · `local`
- `source`: `curated` · `ticketmaster` · `recurring`
- `confidence`: `confirmed` (dated, ticketed) · `annual-estimate` (recurrence-projected, dates not yet
  announced) · `unconfirmed`

`confidence` is load-bearing for a rolling site. When the site projects "Tulsa Oktoberfest, ~late
October 2027," it **must** render visually distinct from a ticketed show. Never let an estimate look
like a fact.

`start`/`end` are date-only (`YYYY-MM-DD`) for multi-day events. `startTime` is a full ISO timestamp
with offset, and is `null` for anything without a door time. Do not conflate them.

### 3.3 Recurring rule — the mechanism that makes the site rolling

This is the most important new type. Annual anchors (Balloon Fiesta, Oktoberfest, county fairs,
Christmas lights) are not in any API and would otherwise require hand-editing every year.

```json
{
  "id": "tulsa-oktoberfest",
  "title": "Tulsa Oktoberfest",
  "placeId": "tulsa-ok",
  "category": "festival",
  "scale": "flagship",
  "attendance": 60000,
  "description": "Voted #1 Oktoberfest in the USA…",
  "url": "https://tulsaoktoberfest.org",
  "rule": { "type": "nth-weekday-of-month", "month": 10, "weekday": 4, "nth": 4, "durationDays": 4 },
  "confirmed": {
    "2026": { "start": "2026-10-22", "end": "2026-10-25" }
  }
}
```

**Rule types to implement:**

| type | fields | example |
|---|---|---|
| `nth-weekday-of-month` | `month`, `weekday` (0=Sun), `nth` (1–5, or `-1` for last), `durationDays` | 4th Thursday of October, 4 days |
| `fixed-month-day` | `month`, `day`, `durationDays` | Oct 3, 9 days |
| `month-span` | `startMonth`, `startWeek`, `endMonth`, `endWeek` | late Nov → early Jan (holiday lights) |
| `weekends-in-month` | `month`, `weekendCount` | Ren fest, every weekend in October |

**Expander behavior** (`scripts/expand-recurring.js`):

- Generate occurrences from `today − 1 month` to `today + 18 months`.
- If `confirmed[year]` exists → emit those exact dates with `confidence: "confirmed"`.
- Otherwise → emit rule-projected dates with `confidence: "annual-estimate"`.
- Always set `recurringId` so the UI can group and so a later confirmation dedupes cleanly.

Adding next year's confirmed dates is then a one-line edit to `confirmed`, and the site is correct
again — no code change, no restructuring.

### 3.4 Artist

```json
{
  "id": "zach-bryan",
  "name": "Zach Bryan",
  "spotifyId": "40ZNYROS4zLfyyBSs2PGe2",
  "ticketmasterAttractionId": "K8vZ917_ob7",
  "rank": 1,
  "source": "spotify-top",
  "genres": ["red dirt", "americana"],
  "lastSyncedAt": "2026-08-09T06:00:00Z"
}
```

`ticketmasterAttractionId` is resolved once by name search and then **cached permanently** in
`curated/artists.json`. Do not re-resolve on every run — it wastes quota and name search is fuzzy.

### 3.5 config.json

Everything tunable lives here so behavior changes don't require code changes.

```json
{
  "origin": {
    "icao": "KWDG",
    "name": "Enid Woodring Regional",
    "lat": 36.3792,
    "lon": -97.7906
  },
  "aircraft": { "type": "T-6", "cruiseKts": 300, "legRangeNm": 400, "reserveNm": 50 },
  "defaults": {
    "rangeNm": 800,
    "westOfMississippiOnly": true,
    "horizonDays": 45,
    "minScale": "notable"
  },
  "rangeSlider": { "min": 50, "max": 1200, "step": 10, "marks": [150, 300, 400, 600, 800, 1000] },
  "scoring": {
    "scaleWeight": { "flagship": 10, "major": 6, "notable": 3, "local": 1 },
    "favoriteArtistMultiplier": 2.5,
    "proximityHalfLifeNm": 450,
    "confidencePenalty": { "confirmed": 1.0, "annual-estimate": 0.75, "unconfirmed": 0.5 },
    "rarityBoost": { "annual": 1.4, "seasonal": 1.1, "recurring": 1.0 }
  },
  "mississippi": [
    [47.24, -95.22], [44.95, -93.09], [41.5, -90.4], [38.63, -90.2],
    [35.15, -90.05], [33.5, -91.1], [32.3, -90.9], [29.95, -90.07]
  ]
}
```

> **Correction to carry over from v1:** v1 uses `{lat: 36.41, lon: -97.88}` as the origin — that's
> Enid the city, not KWDG the airport. Use the field. It shifts every computed distance slightly.

---

## 4. `geo.js` — shared math

Dependency-free, importable from both Node and the browser.

```js
export function greatCircleNm(a, b)          // haversine, Earth radius 3440.065 nm
export function flightMinutes(nm, cruiseKts) // nm / kts * 60
export function legsRequired(nm, legRangeNm) // Math.ceil
export function riverLonAtLat(lat, polyline) // linear interpolation between vertices
export function isWestOfMississippi(place, polyline)
export function planRoute(origin, dest, candidateFields, legRangeNm)
```

### `isWestOfMississippi`

The river polyline is a list of `[lat, lon]` vertices ordered north→south. For a place at latitude
`L`: find the bracketing pair of vertices, linearly interpolate the river's longitude at `L`, and
return `place.lon < riverLon`. If `L` is outside the polyline's latitude span, clamp to the nearest
endpoint. This is cheap and accurate enough for a 20-mile-wide decision boundary.

### `planRoute`

When `legsRequired > 1`, pick a fuel stop: from the set of `vanceApproved` airports, choose the field
minimizing `|leg1 − leg2|` subject to both legs `≤ legRangeNm − reserveNm`. Return
`{ legs: [{from, to, nm, minutes}], totalNm, totalMinutes, stops: [...] }`. Return `null` if no
feasible stop exists, and have the UI say so plainly rather than hiding the destination.

---

## 5. Derived fields

Computed **once** after data load, cached on the in-memory objects. Never persisted, never authored.

```
place.distanceNm       = greatCircleNm(config.origin, place)
place.flightMinutes    = flightMinutes(place.distanceNm, config.aircraft.cruiseKts)
place.legs             = legsRequired(place.distanceNm, config.aircraft.legRangeNm)
place.route            = planRoute(...)            // null when legs === 1
place.isWest           = isWestOfMississippi(place, config.mississippi)
place.nearestAirport   = airport minimizing driveMinutes among vanceApproved
```

Per date-window, recomputed on filter change:

```
place.eventCount       = matching events in window
place.topEvent         = highest-scoring matching event
place.score            = §7.1
```

This is the change that makes the slider and toggle possible. v1 could not have either, because
`"393 nm / ~1h19m"` is a string.

---

## 6. Runtime state and the filter pipeline

### 6.1 State shape (`store.js`)

```js
{
  today:        Date,               // single source of "now"; injectable for testing
  dateRange:    { start, end },     // set by scrubber; defaults today → today+horizonDays
  rangeNm:      800,                // slider
  westOnly:     true,               // toggle
  categories:   Set<string>,        // empty = all
  activities:   Set<string>,        // empty = all
  favoritesOnly: false,
  minScale:     'notable',
  search:       '',
  view:         'map',
  selectedPlaceId: null,
  selectedEventId: null
}
```

Minimal store: `getState()`, `setState(patch)`, `subscribe(fn)`. Notify is synchronous and batched
via `queueMicrotask`. No framework. No two-way binding.

### 6.2 The pipeline

```js
// filters.js — PURE. No DOM, no globals, no side effects.
export function applyFilters(places, events, state, config) {
  // 1. place gate:  distanceNm ≤ rangeNm
  // 2. place gate:  !westOnly || place.isWest
  // 3. place gate:  activities ∩ place.activities (score ≥ 3)
  // 4. event gate:  overlaps dateRange
  // 5. event gate:  placeId ∈ survivingPlaces
  // 6. event gate:  categories, minScale, favoritesOnly
  // 7. text search across title/place/artist/description
  // 8. score + sort
  return { visiblePlaces, visibleEvents, counts };
}
```

**Every view renders from this one return value.** Map pins, feed rows, place rankings, artist show
lists, weekend candidates — all of it. If a view needs data the pipeline doesn't return, extend the
pipeline; do not let a view filter independently.

Memoize on a hash of the state fields the pipeline actually reads, so slider drag doesn't re-run
scoring 60×/second.

### 6.3 Range slider semantics

The slider filters **places** by `distanceNm`. Above the track, show live counts that update as it
moves — this is the core awareness payoff:

> **480 nm** · 24 places · 312 events in window

Mark the track at `config.rangeSlider.marks` with band labels derived from the aircraft config:

| Band | Meaning |
|---|---|
| ≤ 150 nm | under 30 min — after-work hop |
| 150–400 nm | single leg, no fuel stop |
| 400–800 nm | fuel stop required |
| > 800 nm | outside standing rules |

Crossing `legRangeNm` (400) is a real operational boundary, so the UI should mark it visibly on the
track — the slider teaches the constraint rather than just filtering by it.

### 6.4 Mississippi toggle

Off by default = rule in effect (west only). When toggled on, eastern places fade in, and the
river polyline dims from "boundary" styling to "reference" styling. Show the delta:
*"+7 places, +41 events east of the river."* Making the cost of the rule visible is the point.

---

## 7. Scoring

### 7.1 Event relevance

```
score = scaleWeight[scale]
      × (isFavoriteArtist ? favoriteArtistMultiplier : 1)
      × proximityFactor
      × confidencePenalty[confidence]
      × rarityBoost[rarity]

proximityFactor = 2 ^ ( −distanceNm / proximityHalfLifeNm )
```

Exponential distance decay, not linear: a flagship event at 700 nm should still outrank a local
event at 90 nm, but only just. All weights live in `config.scoring` — tune without touching code.

### 7.2 Per-activity place ranking

For activity `a` in the current date window:

```
placeScore(a) = place.activities[a] × 2
              + Σ(event.score for matching events where event maps to a)
              − distancePenalty
```

This produces genuinely different leaderboards per activity — which is the point. v1's single 1–20
list is replaced by six rankings that change as the date window moves.

### 7.3 Weekend candidates (replaces the hand-authored planner)

For each upcoming Fri–Sun in the window:

1. Gather events overlapping that weekend.
2. Group by `placeId`; a place's weekend score is its best event plus a small stacking bonus for
   additional events at the same place.
3. Rank places. Top = primary, next two = backups.
4. **If `curated/overrides.json` names a place for that weekend, it wins** and is badged as a manual
   pick.

The planner becomes derived, so it keeps producing weekends forever. `overrides.json` preserves human
judgment where it matters:

```json
{ "2026-08-15": { "placeId": "santa-fe-nm", "note": "Indian Market — locked" } }
```

---

## 8. Views

### 8.1 Shell

```
┌────────────────────────────────────────────────────────────────┐
│  HEADER: title · "updated 4h ago" · source health dot          │
├──────────┬─────────────────────────────────────────────────────┤
│          │                                                     │
│  FILTER  │                    MAP (landing view)               │
│  RAIL    │                                                     │
│          │                                                     │
│  range   │                                            ┌──────┐ │
│  slider  │                                            │DETAIL│ │
│  west    │                                            │PANEL │ │
│  toggle  │                                            └──────┘ │
│  cats    ├─────────────────────────────────────────────────────┤
│  favs    │  DATE SCRUBBER  ▁▂▅█▃▁▂▇█▅▂▁  (event density)       │
├──────────┴─────────────────────────────────────────────────────┤
│  VIEW TABS:  Map · Feed · Places · Artists · Weekends           │
└────────────────────────────────────────────────────────────────┘
```

Mobile: rail collapses to a bottom sheet; scrubber stays pinned above the tab bar; detail panel
becomes a full-height sheet.

### 8.2 Map — the landing view

- Leaflet, dark tiles, **canvas renderer** (`preferCanvas: true`) — hundreds of pins.
- Pins are places. **Radius scales with `eventCount`** in the current window; **color = dominant
  category**. Empty places render as small hollow rings, not hidden — absence is information.
- Range ring redraws live during slider drag (throttle to `requestAnimationFrame`).
- Mississippi polyline styled per toggle state.
- Cluster below zoom 5.
- Click pin → detail panel. Hover → tooltip with name, flight time, top event.
- Single dark basemap — no layer control. (v1 had a Map/Satellite swap; the satellite
  layer was dropped, so category colors only ever need to work on the dark tiles.)

### 8.3 Date scrubber

A brushable timeline across the bottom with a **weekly event-density histogram**. You should be able
to see, at a glance, that mid-October is stacked and early December is thin. Preset chips: *This
weekend · Next 2 weeks · Next 30 days · Next 90 days · Custom*. Dragging the brush re-filters
everything live.

### 8.4 Feed

Chronological, grouped by weekend, respecting all filters. Row: date · place · flight time ·
category chip · scale dot · ★ if favorite artist · confidence badge if not `confirmed`.

### 8.5 Places

Segmented by activity — Live Music · Nightlife · Food · Art · Outdoors · Weird — each its own
ranking per §7.2, each responding to the date window.

### 8.6 Artists

Favorites first, each with upcoming in-footprint shows. Below: **Notable Shows** — high-scale
concerts in the footprint from non-favorites, so nothing big gets missed. If Spotify sync is stale
or needs re-auth, a quiet inline banner says so.

### 8.7 Weekends

Derived per §7.3. Primary + two backups. Manual overrides badged.

### 8.8 Design tokens

Carry v1's palette forward — it's good, and it's recognizable:

```css
--bg:#0f1115; --panel:#171a21; --panel2:#1e222b; --border:#2a2f3a;
--text:#eef0f4; --muted:#9aa3b2;
--accent:#ff8a3d; --accent2:#3ddc97; --accent3:#5b8def; --gold:#e8c15e;
```

Category colors must be distinguishable at 6px on the dark basemap.

---

## 9. Build plane

### 9.1 `refresh-daily.yml` — 06:00 UTC (~01:00 CT)

```
1. checkout
2. setup-node 20
3. node scripts/fetch-ticketmaster.js   → .cache/tm.json
4. node scripts/fetch-weather.js        → .cache/weather.json
5. node scripts/expand-recurring.js     → .cache/recurring.json
6. node scripts/merge.js                → data/generated/*.json
7. node scripts/validate.js             → exit non-zero on failure
8. always write data/generated/meta.json (even on no-op)   ← keeps Actions alive
9. commit + push if dirty
10. on failure: keep last-good, open/update a GitHub issue
```

Also set `workflow_dispatch` so it can be triggered by hand.

### 9.2 Ticketmaster fetch

Free tier: **5,000 req/day, throttle to ≤2 req/sec.** This design uses ~300.

Two passes:

**A. Artist pass.** For each artist with a cached `ticketmasterAttractionId`, query upcoming events
(`attractionId`, `startDateTime` = now, `endDateTime` = now + 12 months). ~10–30 calls.

**B. Geographic pass.** Do **not** use radius sweeps — results cap at 1,000 per query and the
footprint is huge. Instead iterate `stateCode` over the states inside the 800 nm footprint west of
the river:

```
OK KS TX NM CO AR MO NE IA MN SD ND WY UT AZ LA MT NV
```

For each state, page through `classificationName` in `{music, sports, arts&theatre}` with a rolling
90-day window. Filter results client-side in the script to those within `maxRangeNm` (use the widest
possible range, 1200 nm, so the runtime slider has headroom above the default 800).

**Post-processing:** map each event to the nearest known `placeId` by venue lat/lon within 40 nm; if
none matches, either create a provisional place or drop it — decide via a `strictPlaces` flag in
config, default `true` (drop, and log the miss so places can be added deliberately).

Set `isFavoriteArtist` by matching `artistIds` against `curated/artists.json`.

### 9.3 Spotify sync — weekly, and explicitly fragile

**Two constraints that shape this design:**

1. **Refresh tokens expire after 6 months** (Spotify change effective 2026-07-20). The sync *will*
   break roughly twice a year. This is not an edge case; it is scheduled behavior.
2. **Related Artists and Recommendations are deprecated** for apps created after 2024-11-27 and
   return 403. There is no automatic taste expansion. Artist discovery is `/v1/me/top/artists`
   (scope `user-top-read`) plus manual additions.

**Therefore: `data/curated/artists.json` is the source of truth, and Spotify is an optional
refresher that merges into it.** The site must be fully functional with Spotify permanently broken.

Failure handling — do all four, do not skip any:

- On `invalid_grant`: **do not fail the build.** Keep existing `artists.json` untouched.
- Write `meta.spotify = { status: "reauth_required", lastSuccess: "<iso>" }`.
- Open (or update) a GitHub issue titled `Spotify re-auth needed`.
- Site shows a quiet inline banner on the Artists view — never a blocking modal.

`scripts/spotify-auth.js` is a **local, manual, one-shot helper**: spins a `localhost` listener, runs
the authorization-code flow, prints the new refresh token to paste into repo secrets. It is never run
in CI. Document the ritual in the README as a recurring ~6-month task.

### 9.4 Validation gate

`validate.js` must fail the run — and thereby preserve last-good data — if any of:

- Schema violation on any record (required fields, enum membership, `lat`/`lon` bounds).
- Event count dropped **> 40%** vs. the previous `meta.json`. Catches a silent API outage returning
  an empty 200.
- Any event references a `placeId` that doesn't exist.
- Any place has an invalid or missing coordinate.
- More than 20% of events lack `url`.
- `meta.json` is the **only** file that writes unconditionally, so an all-clear no-op run still
  produces a commit.

That last point is the mitigation for GitHub disabling scheduled workflows after 60 days without
repository activity. Without it, a stretch of quiet days silently kills the automation.

### 9.5 `refresh-weekly.yml` — Sundays

Spotify artist sync · Ticketmaster attraction-id resolution for new artists · link health check
(HEAD requests, flag 404s into `meta.linkHealth`) · prune events that have already ended.

### 9.6 Secrets

`TICKETMASTER_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` — repo
secrets, build plane only.

> **Privacy note:** generated data is committed to a public repo. Top-artist *names* will be public.
> That's presumably fine here, but it is a deliberate choice — never write raw Spotify user profile
> data, listening history, or user IDs into `data/generated/`.

---

## 10. Freshness and trust

The site's credibility depends on never presenting a guess as a fact.

- Header: `Updated 4 hours ago`, from `meta.buildAt`. Amber past 72h, red past 7 days.
- Every `annual-estimate` event carries a badge: *typical dates — 2027 not yet announced*.
- Source health dots for Ticketmaster / Spotify / weather from `meta.sources`.
- Cache-bust JSON with `?v=<meta.buildId>`; fetch `meta.json` first, then the rest in parallel.
- `<meta http-equiv="Cache-Control">` won't help on Pages — rely on the query-string version.

---

## 11. Migration from v1

`scripts/migrate-legacy.js` — run once, then delete.

The 96KB of v1 is real research and must not be retyped. Extract and normalize:

| v1 source | → v2 target |
|---|---|
| `cities`, `boutiqueCities`, `funFlights`, `luxuryDestinations` + parallel `*Coords` | `curated/places.json` (merge duplicates by name; union `kinds`) |
| `calendar`, `concerts` | `curated/events.seed.json` |
| Annual events inside those | `curated/recurring.json` (hand-classify the rule type) |
| `weekends[].city` + `date` | `curated/overrides.json` |
| Airport strings (`"KSAF Santa Fe Municipal — 401nm, direct"`) | parsed into structured `airports[]`; **discard the distance**, recompute |
| `dist` strings (`"393 nm / ~1h19m"`) | **discard entirely** — derived from coords |
| HTML entities (`&mdash;`, `&ndash;`, `&amp;`) | decoded to real characters via `lib/entities.js` |

Two things need human review after the automated pass: classifying recurrence rules, and assigning
per-activity 0–5 scores (v1's flat tags don't carry enough signal — `["art","food"]` doesn't say
whether Santa Fe's food scene is a 3 or a 5).

---

## 12. What v1 features to drop, and why

| Drop | Reason |
|---|---|
| **localStorage notes** | Per-browser, per-device, unshareable. Replaced by URL state (§13) so a link carries the full view to the crew. |
| **"For You (Spotify)" as a separate tab** | Favorites become a *filter* that applies everywhere — map, feed, weekends. A siloed tab hides matches from every other view. The Artists view remains, but as a browse surface, not a silo. |
| **Fixed 19-weekend framing** | Directly contradicts "rolling." Weekends are generated from `today`. |
| **Four separate destination tabs** | Collapsed into Places with `kinds` filtering; the lists overlapped anyway. |
| **Pre-rendered distance/flight strings** | Blocks the slider and the toggle. Derived now. |

---

## 13. URL state

```
#/map?from=2026-09-01&to=2026-10-15&r=520&west=1&cat=concert,festival&fav=1&place=santa-fe-nm
```

Bidirectional: state changes replace history (`replaceState`, throttled); load parses hash and hydrates
before first render. Solves crew sharing for essentially free, and makes bug reports reproducible.

---

## 14. Performance budget

- Total JSON < 1 MB uncompressed; < 200 KB gzipped. If `events.json` exceeds this, split by quarter
  and lazy-load outside the current window.
- Filter pipeline < 16 ms for 5,000 events — memoize, and avoid allocating in the hot path.
- Map pins via canvas renderer; cluster below zoom 5.
- Throttle slider-driven re-renders to `requestAnimationFrame`; debounce text search 150 ms.
- No runtime dependencies except Leaflet (pin it, or vendor it locally to avoid CDN failure).

---

## 15. Implementation phases

Build in this order. Each phase ends at a verifiable checkpoint.

**Phase 1 — Data foundation.** `package.json`, `geo.js` (with unit tests against v1's known
distances), `migrate-legacy.js`, hand-review of `places.json` / `events.seed.json` / `recurring.json`.
✅ *Checkpoint: curated JSON exists; computed distances match v1's authored strings within ~2 nm.*

**Phase 2 — Runtime shell.** `index.html`, tokens/layout CSS, `store.js`, `filters.js`, `format.js`,
map view with pins and range ring, filter rail with slider + west toggle.
✅ *Checkpoint: slider and toggle visibly change the map, driven entirely by derived data.*

**Phase 3 — Time.** Date scrubber with density histogram, feed view, `recurring.json` expansion.
✅ *Checkpoint: brushing dates re-filters map and feed together.*

**Phase 4 — Build plane.** Ticketmaster fetch, merge, dedupe, validate, `refresh-daily.yml`.
✅ *Checkpoint: a manual `workflow_dispatch` produces a real data commit.*

**Phase 5 — Artists.** Spotify sync, `spotify-auth.js`, favorites filter, Artists view, degradation
banner.
✅ *Checkpoint: revoking the refresh token degrades gracefully instead of breaking the site.*

**Phase 6 — Derived views.** Places rankings, weekend generation, overrides, detail panel, URL state,
freshness UI.
✅ *Checkpoint: a shared URL reproduces an exact view.*

**Phase 7 — Polish.** Mobile layout, weather, link health, performance pass, accessibility
(keyboard-navigable map pins, focus management in the detail panel, contrast audit).

---

## 16. Dedupe rules

Curated, recurring, and Ticketmaster records will collide. Match when **all** hold:

- Same `placeId`
- Date overlap within ±1 day
- Normalized title similarity ≥ 0.75 (lowercase, strip punctuation/stopwords, Dice coefficient)

Merge precedence, **field by field** — not whole-record:

| Field | Winner |
|---|---|
| `description`, `scale`, `attendance` | curated |
| `start`, `end` | union of both ranges (earliest start, latest end) |
| `startTime`, `ticketUrl` | ticketmaster |
| `confidence` | highest available |
| `id` | curated if present, else ticketmaster |

Two Ticketmaster records only match on an identical normalized title (fuzzy matching is for
reconciling *different* sources). Every merge is printed to the refresh job's log so a wrong
match is diagnosable rather than invisible; `meta.dedupe` keeps only the counts, since meta.json
is downloaded by every visitor.
