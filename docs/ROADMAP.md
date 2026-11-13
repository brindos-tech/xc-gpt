# XC Scanner (formerly XC GPT): roadmap and handoff

Written 2026-11-11; items 2, 4 and 5 were done the same day (marked DONE below) for whoever picks the work up next. The repo is `brindos-tech/xc-gpt` (the old name `enid-weekend-flight-plan` still redirects); the live site is https://brindos-tech.github.io/xc-gpt/.

## How to read this

Each item is a self-contained work package: what to change, why it matters, where the code is, and what "done" looks like. They are ordered by how much they protect a pilot from a wrong answer, then by how much they improve daily use.

Two kinds of evidence sit behind the items, and each one is marked:

- **[checked]** I looked at the code or the data for this today or during the NOTAM work on 6 November.
- **[from the 5 Nov scan]** A reviewer found it in the pre-launch code scan. It has not been fixed since, but I did not re-verify it today. Confirm it still reproduces before fixing.

## Ground rules for this repo

- Static site, ES modules, no build step. Leaflet 1.9.4 is vendored in `assets/vendor/leaflet`. `scripts/stamp-version.js` stamps `?v=<sha>` at deploy.
- Tests: `node --test tests/unit/*.test.js` and Playwright in `tests/e2e/smoke.test.js`. Deploy is gated on both. In the cloud sandbox the pinned Playwright's own browser is missing: run the browser tests with `CHROMIUM_PATH=/opt/pw-browsers/chromium`. Some browser tests depend on the daily-refreshed event data, so keep their assertions loose.
- Generated weather, TFR and NOTAM data live on the orphan `wx-data` branch, which the deploy copies into `data/generated/wx/`. Workflows force-push that branch.
- Work on a feature branch, open a PR, and merge only when the owner says "merge". After a merge, confirm the "Deploy to Pages" run for the merge commit succeeded.
- The sandbox cannot reach FAA hosts or github.io. Anything that talks to the NOTAM service has to be tested through the "Refresh NOTAMs" workflow.
- NOTAM service limits, from the FAA onboarding email: at most one bulk pull per 24 hours and one data pull per 3 minutes. The published data must never be labelled "FAA data". Credentials live only in GitHub secrets.

## Decisions the owner still has to make

These block or shape work below. None of them needs code to answer.

| Decision | Why it matters | My recommendation |
|---|---|---|
| Retire the Fly comments server? | It is an open, internet-facing server, and its deploy workflow holds a Fly token and uses an action pinned to `@master`. | Retire it unless the ratings and report-a-problem features are being used. See item 3. |
| Keep the Spotify top-50 list public? | `data/curated/artists.json` publishes one person's listening ranks. | Keep the artist names the recommendations need and drop the ranks, or move the file out of the published site. |
| Analytics provider | There is no traffic count today. | GoatCounter: one script tag, no cookies, no consent banner. |
| Project name | Decided: **XC Scanner**, at **xcscanner.com** (formerly XC GPT). | Visible text is renamed. Still on the old name, on purpose: the repository and its web address, storage keys (`xcgpt-*`), the service-worker cache name and the bot name. The custom domain is bought (Squarespace); DNS points at GitHub Pages and the domain is set under Settings, Pages. |

---

## Tier 1: things that can show a pilot a wrong or stale answer

### 1. NOTAM updates through the day [checked]

**Problem.** NOTAMs are pulled once a day at about 09:23 UTC. A runway closed at noon does not appear until the next morning. The crew card prints an "as of" time, but a reader will tend to trust a "None found" line.

**Change.** Add small delta pulls between the daily bulk pulls. The service allows one data pull per 3 minutes; hourly is plenty. The endpoint is `GET /nmsapi/v1/notams?lastUpdatedDate=<ISO time>` with the header `nmsResponseFormat: AIXM`. The answer is JSON shaped `{data:{aixm:["<AIXMBasicMessage…>", …]}}`, which `notamsFromAnswer` in `scripts/lib/nms-aixm.js` already parses.

**Design questions to settle by probing first, not by guessing:**
- How does a cancelled NOTAM appear in a delta? The parser keeps `type` (`N`, `R`, `C`), and `keepShowStoppers` drops `C`, but the published file needs the cancelled entry removed, which means matching it to an existing entry.
- How does a replacement (`R`) name the NOTAM it replaces?
- Does one delta call page, or return everything since the timestamp?

Extend `--probe` to make one delta call and print the first few messages, run it from the workflow, and read the log before writing the merge logic.

**Where.** `scripts/fetch-notams.js`, `scripts/lib/nms-aixm.js`, `.github/workflows/refresh-notams.yml`, tests in `tests/unit/notams-fetch.test.js` (there is a fake NMS server to extend).

**Done when.** A closure issued after the morning pull appears within about an hour; a cancelled closure disappears; the daily bulk pull still resets the state; no run makes more than one bulk pull a day; the file carries both the bulk time and the last delta time.

**Fallback if deltas prove unreliable.** Make the staleness loud instead: see item 2.

### 2. Tell the user how old every data source is: DONE (radar excluded) [checked for NOTAMs, from the 5 Nov scan for the rest]

**Done:** `assets/js/planner/data-age.js` holds the limits (forecast 18 h, TFRs 3 h, NOTAMs 30 h); `main.js` shows a banner when a source passes its limit and when the date rolls over; the crew card says "NOTAM data is N old" and never prints a bare "None found" from a stale file. Radar is not covered: its tiles are live from the weather service and have no build time.

**Problem.** Forecast, TFRs, radar and NOTAMs each have a build time, but the page does not warn when one has stopped refreshing. A failed workflow leaves old data looking current. "Today" also does not roll over if the tab stays open past midnight.

**Change.** One shared helper that takes a source's `builtAt` and its expected refresh interval and returns fresh, ageing or stale. Show a quiet stamp when fresh and a visible banner when stale. Suggested thresholds: forecast 18 h, TFRs 3 h, NOTAMs 30 h, radar 30 min. On the crew card, a stale NOTAM file should print "NOTAM data is N hours old" instead of "None found". Recompute "today" on visibility change.

**Where.** `assets/js/planner/wx-controller.js`, `wx-data.js`, `crew-card.js`, `notams.js` (`notamLines`), `main.js`.

**Done when.** With a fake clock in the e2e tests, each source shows the banner past its threshold, and the crew card never prints "None found" from a stale file.

### 3. Retire or lock down the comments server [from the 5 Nov scan]

**Problem.** `server/` is deployed to Fly with no access control on writes, and `.github/workflows/deploy-comments.yml` uses `superfly/flyctl-actions/setup-flyctl@master` while holding `FLY_API_TOKEN`. An unpinned action with a deploy token is a supply-chain risk.

**Change, if retiring.** Remove `commentsApi` from `data/curated/config.json` and the client code that calls it, delete the workflow and `server/`, drop `tests/unit/comments-server.test.js`. The owner then runs `fly apps destroy xc-gpt-comments` and deletes the `FLY_API_TOKEN` secret.

**Change, if keeping.** Pin the action to a commit SHA, add rate limiting and a size cap on writes, and restrict CORS to the site origin.

**Done when.** No workflow references an unpinned third-party action, and either the server is gone or it rejects abusive writes in a test.

### 4. Pin and restrict what the page loads: DONE [checked]

**Done:** Leaflet is now served from `assets/vendor/leaflet/` (unmodified npm 1.9.4 with hashes in its README), so no script comes from a CDN, and `index.html` carries a Content-Security-Policy. Every browser test fails on a policy violation. If a new host is added (a new tile source, API or image host), add it to the policy or the page will block it.

**Problem.** `index.html` loads Leaflet's script and stylesheet from cdnjs with no `integrity` attribute, and the page has no Content-Security-Policy.

**Change.** Add SRI hashes to both Leaflet tags. Add a CSP `<meta>` allowing only self, cdnjs, the tile host, and the hosts the page fetches from. Check the service worker's cache-first path for cdnjs still works with `integrity`.

**Done when.** The e2e suite passes with the CSP in place and the browser console shows no CSP violations on any page.

### 5. Label partial runway closures correctly: DONE [checked]

**Done:** `showStopper` returns "Runway restricted" for closures limited to some traffic ("CLSD TO LDG", "CLSD TO TGL") or to certain hours ("CLSD DLY 0530-1130"); closed-except-something stays "Runway closed". The crew card does not yet use the `schedule` field to compare those hours with the stay.

**Problem.** The live NOTAM file labels these "Runway closed": `RWY 12R CLSD TO AIR CARRIER DEP`, `RWY 17/35 CLSD TO TGL`, `RWY 04R/22L CLSD TO STUDENT EXC 1HR PPR`, `RWY 30L CLSD TO TKOF`, and time-limited ones such as `CLSD DLY 0530-1130`. The full text prints underneath, so nothing is hidden, but the bold label overstates it.

**Change.** In `showStopper` (`assets/js/planner/notams.js`), return a third kind, "Runway restricted", when the closure is followed by `TO …`, and keep "Runway closed" for outright closures. Leave `EXC TAX` and `EXC XNG` as closed: the runway is not usable for takeoff or landing. Consider reading the `schedule` field the parser already extracts, so a "DLY 0530-1130" closure is only flagged when the stay overlaps those hours.

**Done when.** Unit tests cover each real example above, taken from the published file.

---

## Tier 2: usability problems found in the scan [from the 5 Nov scan]

Each is small. Confirm it reproduces, fix it, add a test.

6. **Landing after midnight is not counted as an overnight.** `scheduleTrip` derives RON from later-day takeoffs only (`assets/js/planner/trip.js`).
7. **Ctrl+P prints a blank crew card.** The card is only filled by the Print button; add a `beforeprint` handler (`crew-card.js`).
8. **Focus is lost while editing a takeoff time**, because the panel re-renders (`views/trip-panel.js`).
9. **Enter in the arrival box can add a stale suggestion** (`views/trip-panel.js`).
10. **One search box filters every tab.** Give each tab its own query (`filters.js`, `url-state.js`).
11. **"This weekend" preset means today + 3 days**, not the coming Saturday and Sunday (`weekends.js`).
12. **The place sheet shows weather for past days.**
13. **Events load failure is sticky and invisible on phones.** Add a Retry control.
14. **Field sheet scroll position jumps** on re-render (`planner/field-panel.js`).
15. **A failed `navinfo.json` or `config.json` load blanks the whole app.** Show an error with a reload button (`main.js`).
16. **FBO-closed flag is wrong after midnight** at fields that close late (`planner/hours.js`).
17. **Airspace sheet ids collide**: 134 special-use areas share names, so the wrong sheet can open (`airspace.js`).
18. **Redraw cost on slider moves.** Moving the time slider redraws more than it needs to (`wx-controller.js`, `views/scrubber.js`).

## Tier 3: performance and upkeep

19. **`events.json` is 7.6 MB** [checked]. It loads lazily, but it is still large for a phone. Trim unused fields, drop events outside the planning window, or split it by month.
20. **GitHub Actions are on Node 20 runtimes** [checked]. Every run logs a deprecation warning for `actions/checkout@v4` and `actions/setup-node@v4`. Move to the current major versions across all ten workflows.
21. **Bring the docs up to date** [checked]. `README.md` and `ARCHITECTURE.md` do not mention the NOTAM service, its limits, `FAA_NMS_LIVE`, or the probe. Add a short operations section: which secrets and variables exist, what each workflow does, and what to do when one fails.
22. **Split the largest test files.** `tests/unit/planner.test.js` is 60 KB and `tests/e2e/smoke.test.js` is 54 KB. Splitting by feature makes failures easier to read. No behaviour change.
23. **Alert on a failed data refresh.** `refresh-daily.yml` already opens an issue on failure; give the weather, TFR and NOTAM workflows the same treatment so a silent failure is noticed before a pilot notices stale data.

## Tier 4: new features worth building

Ordered by value to a pilot planning a cross-country.

24. **NOTAMs on the field sheet and the map.** They appear only on the crew card today [checked]. Show the closures on the field's sheet, and mark fields with an active airport closure on the map.
25. **Leg fuel and time check.** `config.json` already has cruise speed and leg range [checked]. Flag a leg that exceeds range with a headwind allowance, using the forecast winds the site already fetches.
26. **Crosswind check per runway.** Field facts have runway headings and the forecast has surface wind. Show the crosswind component at the ETA and flag it against a limit the owner supplies.
27. **Alternate suggestion.** The site already flags "Alternate may be required". Suggest the nearest approved fields whose forecast at the ETA is above alternate minimums.
28. **Traffic counting.** Add the analytics script once the owner picks a provider.
29. **Share a plan as a short link or QR code** for the crew card, so the other pilot can open the same plan on a phone.

## Suggested order

1. Items 3 and 4: small, remove real exposure.
2. Item 2: makes every later data problem visible.
3. Item 5, then item 1: the NOTAM feed becomes accurate, then timely.
4. Tier 2 in any order, a few per PR.
5. Items 20, 21 and 23 together as one housekeeping PR.
6. Tier 4 as the owner prioritises.

## Things I would not do

- Do not bring back the field-by-field NOTAM loop. 364 requests in a row breaks the service's rate limit.
- Do not add a build step or a framework. The no-build setup is why deploys are fast and the tests are simple.
- Do not cache map tiles in the service worker; the tile provider's policy discourages it.
