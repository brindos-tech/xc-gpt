# XC GPT

A nav planner for T-6 cross-country missions, with the events map that started the project as page 2. See [ARCHITECTURE.md](ARCHITECTURE.md) for the original design.

- **Planner (home)** — the Vance Nav Info List on a map from the selected base, with the range ring, a Nav Info List / P-coded fields switch, quick filters (fuel available, DLA fuel contract, AIR Card on-site, T-6 suitable, FBO, military), and toggleable airspace: MOAs, restricted, warning and alert areas (on by default), IR / VR / SR training routes (off). Click a field for its FBO and phone, Land / Fuel / RON status, nav-list notes, FAA facts (runway, tower, fuel, hours) and GSA per diem; click an airspace for its scheduling activity, hours and procedures.
- **Events** — destinations with events in a date range (From / To calendar boxes), by category and activity, with the PR ops chip. Loads only when opened.

## The planner's data

| File | Source | How it updates |
|---|---|---|
| `data/curated/navinfo.json` | Vance Nav Info List PDF (71 OSS/OSOP) | `python3 scripts/import-navinfo.py <pdf>` when a new list is published. `CODE_FIXES` in that script maps codes the list gets wrong (K01R → 0R1, KPBI → KDJT). |
| `data/curated/aircard.json` | AIR Card merchant export (CSV) | `python3 scripts/import-aircard.py <csv>` — manual re-export; the file goes stale, and the field sheet shows each merchant's last-updated date. Merchant e-mail addresses are dropped; only fields on the nav list are kept. |
| `data/curated/ap1.json` | DoD FLIP AP/1A (SUA) and AP/1B (MTR) text exports | `node scripts/import-ap1.mjs <AP1A.txt> <AP1B.txt>` each 8-week FLIP cycle |
| `data/generated/field-facts.json` | FAA NASR 28-day subscription + GSA per diem | `refresh-fields.yml`, weekly |
| `data/generated/approaches.json` | FAA d-TPP metadata (`d-TPP_Metafile.xml`, 28-day cycle): instrument approach chart names per field | `refresh-approaches.yml`, weekly (commits only on change). `assets/js/planner/approaches.js` classifies them into ILS / LOC / LOC BC / VOR / RNAV / TACAN / NDB / Hi approach / circling-only for the planner's Approaches filter |
| `data/curated/state-tax.json` | GSA SmartPay state tax pages (updated 1 Jul 2026): per state, whether federal travelers are exempt from lodging/occupancy tax (exempt / exempt with a form / centrally billed accounts only / nothing lodging-specific), with the form and the GSA page link | by hand when GSA updates its pages (re-read each state's page at https://smartpay.gsa.gov/smarttax/tax-information-by-state/) |
| `wx/tfr.json` (on `wx-data`) | FAA TFR site (WFS shapes + list types) | `refresh-tfr.yml` hourly; the page reads it straight from the branch (raw.githubusercontent.com), so TFRs don't wait for a deploy |
| `data/generated/airspace-{sua,mtr}.json` | FAA SUA / MTR geometry merged with `ap1.json` | `refresh-fields.yml`, weekly |
| `wx/` (branch `wx-data`, served at `data/generated/wx/`) | Open-Meteo GFS pressure-level forecast, 1° grid + every nav-list field, 3-hourly for 8 days | `refresh-wx.yml`, twice daily; **not committed to main** — force-published as one commit on `wx-data`, which `deploy-pages.yml` copies into the site |

Planning reference only — the page says so. ForeFlight / FLIP / NOTAMs remain the source for what's actually allowed and open.

### Trip builder and crew card

“Add to trip” on a field sheet puts it in the rail's **Trip** list: reorder, mark RON, return to base. It shows legs and flight time from the base (flagging legs beyond the 400 nm leg range), a GSA per diem estimate (lodging per RON field, meals at 75 % on the first and last day), a route string to paste into ForeFlight, and **Print crew card** — a one-page-per-stop printout (FBO + phone, approvals, gov't fuel merchants, hours/sunset, per diem, lodging-tax note). Trips live in the URL (`trip=KOKC*,KTUL`, `*` = RON). Field sheets also show sunrise/sunset/twilight in the field's own time and flag FBO hours (read from the FAA attendance text) that are closed that day or end before sunset.

### Comments

Anyone can rate and comment on a field/FBO or an airspace area/route from its sheet (rating, free food, fees, crew car, AIR Card accepted, planespotters, other amenities, date visited, notes). They're stored by a small API on Fly.io (`server/`, see `server/README.md` for the one-time setup); the site reaches it through `commentsApi` in `data/curated/config.json`. The owner reads and deletes comments at `<api>/admin`. “Report a problem” on a sheet sends a private correction report (never shown publicly, flagged **REPORT** in the admin log); rated fields show a gold ★ label on the map and a “Has comments” filter. If the API is down the sheets just say comments are offline.

### Weather overlays

The planner's weather bar (day picker today…+7, local-time slider, overlays) draws radar, flight category, low/high icing, ceiling and thunderstorms from that forecast grid. `assets/js/planner/wx-model.js` derives the layers: icing where a pressure level is −20…0 °C with cloud cover ≥ 40 % (low < 10,000 ft MSL, high 10,000–25,000 ft); ceiling from the lowest level with ≥ 50 % cloud above ground; flight category from ceiling and visibility. It is a **planning aid, not a weather brief** — ~60 nm grid, ~1,500 ft vertical spacing. “Radar” is live NEXRAD (Iowa Environmental Mesonet tiles) only at “now”; any other time shows model precipitation instead. The page hides the weather bar if no forecast has been published. Open-Meteo's free tier is non-commercial and limited per day, so keep the schedule at two runs.

## Running it locally

Static site, no build step. From this directory:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. (Node isn't required to run the site — only to run the CI data-refresh scripts under `scripts/`.)

## Data model

- `data/curated/*.json` — hand-edited, source of truth (places, artists, seed events, recurring-event rules, weekend overrides). Edit these directly for anything a human decided.
- `data/generated/*.json` — CI-written by the GitHub Actions workflows. Never hand-edit; a manual edit will be overwritten by the next scheduled run.

## PR opportunities

The **PR ops** chip (Category row) shows events where military aircraft could plausibly take part — air shows wanting static displays or flyovers, military appreciation / Salute to Service games, games at venues that have hosted military flyovers, patriotic-holiday games, bowl games and motorsport with flyover traditions. Each tagged event says why (`scripts/lib/pr.js`). Sources:

- **Automatic tagging** of every Ticketmaster / SeatGeek / curated event, plus nationwide keyword sweeps of both APIs ("military appreciation", "salute to service", "air show"…).
- **MLB / MiLB team promotions** from the public MLB Stats API (`scripts/fetch-mlb-promotions.js`, no key) — "Military Appreciation Night" and similar, for every pro and minor-league ballpark near a curated place.
- **`data/curated/pr-events.json`** — hand-researched games and events (NFL Salute to Service, college military games, Army–Navy, military bowls). Each entry tags the matching listing, or is added as its own event when no feed lists it.
- **`data/curated/pr-venues.json`** — venues with documented T-6 / military flyovers; outdoor games there are tagged.
- **Weekly leads** (`scripts/fetch-pr-leads.js`, optional keys below): a web-search sweep and DVIDS flyover history, collected into `data/generated/pr-leads.json` (the page no longer shows it since the Feed was removed).

Tags flag *candidates*. Actual participation goes through the base's public affairs and the USAF Aerial Events process (requests ≥45 days out, typically 90–120), and there is no public feed of approved flyovers.

## GitHub Actions setup

Two scheduled workflows regenerate `data/generated/`:

- **`.github/workflows/refresh-daily.yml`** — pulls Ticketmaster and SeatGeek events, weather, expands `recurring.json`, merges, validates, commits.
- **`.github/workflows/deploy-comments.yml`** — deploys `server/` to Fly on changes (skips until the `FLY_API_TOKEN` secret exists).
- **`.github/workflows/refresh-approaches.yml`** — weekly: approach charts per field from the FAA d-TPP.
- **`.github/workflows/refresh-tfr.yml`** — hourly: TFRs into the `wx-data` branch (see above).
- **`.github/workflows/refresh-wx.yml`** — twice daily: the forecast grid, published to the `wx-data` branch (see above).
- **`.github/workflows/refresh-fields.yml`** — weekly: NASR + per-diem field facts and the airspace layers (see above).
- **`.github/workflows/refresh-weekly.yml`** — syncs Spotify top artists, resolves new Ticketmaster attraction IDs, rebuilds, checks link health.

A third publishes the site:

- **`.github/workflows/deploy-pages.yml`** — on every push to `main`, and after every successful refresh run (their bot commits can't trigger a `push` workflow themselves), runs the test suite, then assembles `index.html` + `assets/` + `data/` and runs `scripts/stamp-version.js` to append `?v=<short-sha>` to every local CSS/JS reference *and* to the relative imports inside each ES module, then deploys to Pages.

  This exists because Pages serves everything with `Cache-Control: max-age=600` and gives you no way to override it, so a just-merged change could take ~10 minutes to appear — indistinguishable from a broken deploy. Stamping the whole module graph (not just the `main.js` entry point — a query string there doesn't propagate into its own `import "./store.js"` statements) makes each deploy a fresh set of URLs, so changes land immediately.

  **This requires Settings → Pages → Source = "GitHub Actions".** Left on "Deploy from a branch", this workflow fails at the deploy step while the old branch-based deploy keeps publishing unstamped assets.

A fourth gates it:

- **`.github/workflows/test.yml`** — unit tests (`npm run test:unit`, plain `node:test`) and a Playwright smoke test of the stamped site (`npm run test:e2e`). Runs on every PR and as the first job of every deploy. Locally: `npm ci && npx playwright install chromium && npm test`.

Add these repo secrets (Settings → Secrets and variables → Actions):

| Secret | Used by |
|---|---|
| `TICKETMASTER_API_KEY` | daily + weekly |
| `SEATGEEK_CLIENT_ID` | daily (free key from seatgeek.com/account/develop) |
| `TAVILY_API_KEY` *or* `BRAVE_API_KEY` | weekly PR leads web sweep (optional; free tiers cover it) |
| `DVIDS_API_KEY` | weekly T-6 flyover history from DVIDS (optional; free key at api.dvidshub.net) |
| `SPOTIFY_CLIENT_ID` | weekly |
| `SPOTIFY_CLIENT_SECRET` | weekly |
| `SPOTIFY_REFRESH_TOKEN` | weekly |

Without these secrets the workflows still run and commit — they just skip the fetch they're missing credentials for and leave the last-good data in place. Nothing breaks.

## The Spotify re-auth ritual (recurring, ~every 6 months)

Spotify refresh tokens now expire 6 months after the original authorization (a change effective 2026-07-20) — refreshing the access token does **not** reset that clock. This will break the weekly Spotify sync roughly twice a year. That's expected, not a bug: when it happens, `fetch-spotify.js` exits cleanly, leaves `artists.json` untouched, and the Artists view shows a quiet banner instead of breaking.

To fix it — **put a reminder on your calendar for every ~5 months** so you catch it before it lapses:

```bash
SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... node scripts/spotify-auth.js
```

This opens an auth URL, catches the redirect on `localhost`, and prints a new refresh token. Paste it into the `SPOTIFY_REFRESH_TOKEN` repo secret, then re-run the failed workflow from the Actions tab.

Also worth knowing: Spotify's Related Artists and Recommendations endpoints are dead for apps created after 2024-11-27, so there's no automatic "similar artists" expansion. Add those by hand to `data/curated/artists.json` (`source: "manual"`) — the sync only refreshes rank and confirms `/me/top/artists`, it never deletes a manual entry.

## Editing the season

- **New annual event to track:** add a rule to `data/curated/recurring.json`. Once you know next year's real dates, add them under that entry's `confirmed` map and the projection is replaced by the confirmed date automatically.
- **Lock a specific weekend's primary pick:** add/edit an entry in `data/curated/overrides.json`, keyed by any date inside that Fri–Sun span.
- **Add a place:** append to `data/curated/places.json`. Distance, flight time, and west-of-river status are all computed at runtime — never hand-author them.

## Migration note

v2 replaced the v1 single-file `index.html` catalog (fixed Aug–Dec 2026 season, prose-embedded events, hand-authored distances). All of v1's research was preserved and migrated by hand into the `data/curated/*.json` schema — cross-validated against v1's authored distances (haversine math checked to within ~1nm using v1's origin point) and every recurrence rule checked against known 2026 dates before being trusted to project 2027+.
