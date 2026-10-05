# XC GPT

A rolling situational-awareness site for weekend cross-country flight planning — not a booking checklist. Map-first, date-scrubbable, filtered by range and activity, with departure bases at Vance (Enid, OK), Columbus, and Laughlin AFB. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## Running it locally

Static site, no build step. From this directory:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. (Node isn't required to run the site — only to run the CI data-refresh scripts under `scripts/`.)

## Data model

- `data/curated/*.json` — hand-edited, source of truth (places, artists, seed events, recurring-event rules, weekend overrides). Edit these directly for anything a human decided.
- `data/generated/*.json` — CI-written by the GitHub Actions workflows. Never hand-edit; a manual edit will be overwritten by the next scheduled run.

## GitHub Actions setup

Two scheduled workflows regenerate `data/generated/`:

- **`.github/workflows/refresh-daily.yml`** — pulls Ticketmaster events, weather, expands `recurring.json`, merges, validates, commits.
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
