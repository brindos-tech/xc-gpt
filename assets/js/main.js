import { createStore } from "./store.js";
import { initUrlState } from "./url-state.js";
import { formatUpdatedAgo, parseDate } from "./format.js";
import { staleSources, staleMessage } from "./planner/data-age.js";
import { createFilterRail } from "./views/filter-rail.js";
import { initWelcome } from "./views/welcome.js";
import { createPlannerView } from "./planner/planner-view.js";
import { createFieldPanel } from "./planner/field-panel.js";
import { mergeFields, selectFields, meetsRunway } from "./planner/fields.js";
import { createWxController } from "./planner/wx-controller.js";
import { createTripPanel } from "./views/trip-panel.js";
import { createWeekendsPage } from "./views/weekends-page.js";
import { crewCardHtml } from "./planner/crew-card.js";

const DATA_BASE = "data";

// Replaced with the deploy's commit SHA by scripts/stamp-version.js. Every
// data refresh is its own deploy, so the SHA changes exactly when the data
// does: repeat visits get a cheap 304 instead of re-downloading, and a new
// deploy is never masked by a cached copy. Left unstamped (local dev), fall
// back to a fresh fetch every load.
const BUILD_VERSION = "__BUILD_VERSION__";
const DATA_VERSION = BUILD_VERSION.startsWith("__") ? String(Date.now()) : BUILD_VERSION;

async function loadJson(path) {
  const res = await fetch(`${DATA_BASE}/${path}?v=${DATA_VERSION}`);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

// Installable app + offline fallback for the last-loaded data (see sw.js).
// Registered after load so it never competes with the first render.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service worker not registered:", err));
  });
}

async function boot() {
  initWelcome(); // static markup: shown at once, before the data loads
  // The planner is the home page, so only its data loads up front. The
  // events page (≈2 MB of event data) loads the first time it's opened.
  const [config, navinfo, factsFile, meta, aircard, approaches, stateTax] = await Promise.all([
    loadJson("curated/config.json"),
    loadJson("curated/navinfo.json"),
    loadJson("generated/field-facts.json").catch(() => null),
    loadJson("generated/meta.json").catch(() => null),
    loadJson("curated/aircard.json").catch(() => null),
    loadJson("generated/approaches.json").catch(() => null),
    loadJson("curated/state-tax.json").catch(() => null),
  ]);

  const originsById = new Map(config.origins.map((o) => [o.id, o]));
  // fields with a known runway shorter than the cutoff (4,000 ft) are not drawn or searchable
  const fields = mergeFields(navinfo, factsFile, aircard, approaches).filter((f) => meetsRunway(f, config.defaults.minRunwayFt || 0));

  // The real current date at local midnight — not the build date. Event
  // dates parse to local midnight, and the window test compares against it,
  // so a mid-afternoon "today" would drop a single-day event from its own day.
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const store = createStore(config, today);
  let currentOriginId = store.getState().originId;

  const $ = (id) => document.getElementById(id);
  const app = document.querySelector(".app");
  const panes = { planner: $("pane-planner"), weekends: $("pane-weekends"), events: $("pane-events") };
  const tabBar = $("tabBar");
  const searchInput = $("globalSearch");
  const freshnessText = $("freshnessText");
  const freshnessDot = $("freshnessDot");

  const fieldsByCode = new Map(fields.map((f) => [f.code, f]));
  const filterRail = createFilterRail({ store, config });
  const fieldPanel = createFieldPanel({ store, getOriginIcao: () => originsById.get(store.getState().originId)?.icao });

  // show-stopper NOTAMs (airport/runway closed...), refreshed by CI; the card says so when they are not available
  let notamsFile = null;
  (config.notamsUrl ? fetch(config.notamsUrl, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))) : Promise.reject(new Error("no url")))
    .catch(() => loadJson("generated/wx/notams.json"))
    .then((d) => {
      notamsFile = d;
      checkFreshness();
    })
    .catch(() => null);

  /** Fill the print-only crew card for the current trip and open the print dialog. */
  function printCrewCard() {
    const state = store.getState();
    const origin = originsById.get(state.originId);
    const trip = tripPanel.compute(state, origin);
    if (!trip.stops.length) return;
    const [y, m, d] = state.tripDate.split("-").map(Number);
    const dataNotes = [
      navinfo.asOf && `Nav list ${navinfo.asOf}`,
      factsFile?.nasrCycle && `FAA cycle ${factsFile.nasrCycle}`,
      aircard?.exportDate && `AIR Card export ${aircard.exportDate}`,
      approaches?.cycle && `d-TPP ${approaches.cycle}`,
    ].filter(Boolean);
    $("crewCard").innerHTML = crewCardHtml({
      origin,
      stops: trip.stops,
      legs: trip.legs,
      legRangeNm: config.aircraft.legRangeNm,
      schedule: trip.schedule,
      cost: trip.cost,
      tripDate: new Date(y, m - 1, d),
      route: trip.route,
      stateTaxes: stateTax?.states,
      dataNotes,
      forecastAt: (code, instant) => wx.forecastAt(code, instant),
      notams: notamsFile,
      notamsWanted: true,
    });
    const prev = document.title;
    document.title = `Crew card ${origin.icao} ${state.tripDate}`;
    window.print();
    document.title = prev;
  }
  // ---- flight plan bar: docked on the right (desktop) or a bottom sheet (phone) ----
  const tripBar = $("tripBar");
  const tripBackdrop = $("tripBackdrop");
  // closed until there is a plan: shared links with legs open it, and so does adding the first one
  if (!store.getState().trip.length) app.dataset.trip = "closed";
  let prevStops = store.getState().trip.length;
  function setTripBar(open) {
    if (window.matchMedia("(max-width: 860px)").matches) {
      tripBar.classList.toggle("open", open);
      tripBackdrop.classList.toggle("open", open);
      $("tripToggle").setAttribute("aria-expanded", String(open));
    } else {
      if (open) delete app.dataset.trip;
      else app.dataset.trip = "closed";
      requestAnimationFrame(() => planner.invalidateSize());
    }
  }
  $("tripBarClose").addEventListener("click", () => setTripBar(false));
  $("tripOpenTab").addEventListener("click", () => setTripBar(true));
  $("tripToggle").addEventListener("click", () => setTripBar(!tripBar.classList.contains("open")));
  tripBackdrop.addEventListener("click", () => setTripBar(false));

  const weekendsPage = createWeekendsPage({ root: $("weekendsPage"), store, config, loadJson, today });
  const tripPanel = createTripPanel({ store, config, fieldsByCode, getOrigin: () => originsById.get(store.getState().originId), onPrint: printCrewCard, forecastAt: (code, instant) => wx.forecastAt(code, instant) });

  // ---- planner ----
  const planner = createPlannerView({
    config,
    origin: originsById.get(currentOriginId),
    loadJson,
    onFieldClick: (id) => store.setState({ selectedFieldId: id, selectedAirspaceId: null }),
    onAirspaceClick: (id) => store.setState({ selectedAirspaceId: id, selectedFieldId: null }),
    onAirspaceStatus: (key, text) => filterRail.setAirspaceStatus(key, text),
  });
  const wx = createWxController({ store, map: planner.map, loadJson, today, onChange: () => render() });
  $("plannerLegend").innerHTML = planner.legendHtml();

  // ---- stale-data banner: a data file that has stopped refreshing, or a date that has rolled over ----
  // Forecast, TFR and NOTAM files are rebuilt by scheduled workflows; if one stops, the last file would otherwise keep
  // looking current. Rechecked every minute and whenever the tab comes back (a laptop can sleep for hours).
  const loadedDay = new Date().toDateString();
  const staleBanner = $("staleBanner");
  function checkFreshness() {
    const at = new Date();
    const stale = staleSources({ forecast: wx.builtAt, tfr: planner.dataBuiltAt("tfr"), notams: notamsFile?.builtAt }, at);
    const messages = [];
    if (at.toDateString() !== loadedDay) messages.push("It is a new day since this page loaded: reload to update the dates and the forecast.");
    if (stale.length) messages.push(staleMessage(stale));
    $("staleText").textContent = messages.join(" ");
    staleBanner.classList.toggle("show", messages.length > 0);
  }
  $("staleReload").addEventListener("click", () => location.reload());
  setInterval(checkFreshness, 60000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkFreshness();
  });

  // ---- events (lazy) ----
  let eventsPage = null;
  let eventsLoading = false;
  let eventsError = null;
  async function ensureEventsPage() {
    if (eventsPage || eventsLoading) return;
    eventsLoading = true;
    try {
      const { createEventsPage } = await import("./events/events-page.js");
      eventsPage = await createEventsPage({ store, config, meta, loadJson });
    } catch (err) {
      console.error(err);
      eventsError = err.message;
    }
    eventsLoading = false;
    render();
    requestAnimationFrame(() => eventsPage?.invalidateSize());
  }

  // ---- header: search + freshness ----
  let searchDebounce;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => store.setState({ search: searchInput.value }), 150);
  });

  // Enter in the search box zooms to the match again (after the map has been panned away)
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && store.getState().view === "planner") {
      clearTimeout(searchDebounce);
      // same text as before: just zoom again; new text: the render below zooms once
      if (store.getState().search === searchInput.value) zoomToMatches(lastHits, searchInput.value);
      else store.setState({ search: searchInput.value });
    }
  });

  function renderFreshness(view) {
    if (view === "events" && meta?.buildAt) {
      // `now`, not `today`: freshness is an elapsed-hours measure.
      freshnessText.textContent = `Events updated ${formatUpdatedAgo(meta.buildAt, now)}`;
      const hours = (now - new Date(meta.buildAt)) / 3600000;
      freshnessDot.className = "source-dot " + (hours < 72 ? "ok" : hours < 168 ? "stale" : "error");
    } else if (view === "planner") {
      const asOf = navinfo.asOf ? parseDate(navinfo.asOf).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "2-digit" }) : "unknown date";
      freshnessText.textContent = `Nav list ${asOf}${factsFile?.nasrCycle ? ` · FAA ${factsFile.nasrCycle}` : ""}`;
      freshnessDot.className = "source-dot " + (factsFile ? "ok" : "stale");
    } else if (view === "weekends" && meta?.buildAt) {
      freshnessText.textContent = `Events updated ${formatUpdatedAgo(meta.buildAt, now)}`;
      freshnessDot.className = "source-dot ok";
    } else {
      freshnessText.textContent = "Bootstrap data (no CI run yet)";
      freshnessDot.className = "source-dot stale";
    }
  }

  // ---- page switching ----
  tabBar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (btn) store.setState({ view: btn.dataset.view });
  });

  let lastView = null;
  function syncPage(view) {
    if (view === lastView) return;
    lastView = view;
    app.dataset.page = view;
    Object.entries(panes).forEach(([key, el]) => el.classList.toggle("active", key === view));
    tabBar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    searchInput.placeholder = view === "planner" ? "Search fields, FBOs…" : view === "weekends" ? "Narrow the picks: rodeo, concert, a team…" : "Search places, events…";
    // Leaflet measures 0×0 inside a hidden pane.
    if (view === "planner" || view === "events") requestAnimationFrame(() => (view === "planner" ? planner.invalidateSize() : eventsPage?.invalidateSize()));
    if (view === "events") ensureEventsPage();
  }

  // ---- render ----
  let lastSearch = "";
  let lastHits = [];

  function zoomToMatches(hits, query) {
    const q = (query || "").trim().toLowerCase();
    if (q.length < 2 || !hits.length) return;
    const exact = hits.find((f) => [f.code, f.faaId].some((c) => c && c.toLowerCase() === q));
    if (exact || hits.length === 1) planner.flyTo((exact || hits[0]).lat, (exact || hits[0]).lon);
    else if (hits.length <= 40) planner.fitTo(hits.map((f) => [f.lat, f.lon]));
  }
  let airspaceLoadRequested = null;

  function renderPlanner(state) {
    const origin = originsById.get(state.originId);
    planner.updateRange(state.rangeNm);
    const selection = selectFields(fields, state, origin, config);
    planner.renderFields(selection, state.selectedFieldId, wx.fieldRing);
    wx.render(state);
    const tripInfo = tripPanel.render(state, origin);
    const stopCount = tripInfo.stops.length;
    if (stopCount > prevStops && app.dataset.trip === "closed" && !window.matchMedia("(max-width: 860px)").matches) setTripBar(true);
    prevStops = stopCount;
    const legCount = tripInfo.legs?.legs.length || 0;
    for (const id of ["tripCount", "tripOpenCount", "tripToggleCount"]) $(id).textContent = legCount ? `(${legCount} leg${legCount === 1 ? "" : "s"})` : "";
    planner.setTrip(tripInfo.stops.length ? [[origin.lat, origin.lon], ...tripInfo.stops.map((s) => [s.field.lat, s.field.lon]), ...(state.tripReturn ? [[origin.lat, origin.lon]] : [])] : []);
    planner.setAirspace(state.airspace, state.selectedAirspaceId);

    const label = state.fieldSource === "p" ? "P-coded" : "nav-list";
    const unmapped = fields.filter((f) => !f.hasPosition).length;
    filterRail.setCounts(
      `${selection.inRange} ${label} field${selection.inRange === 1 ? "" : "s"} in range` +
        (state.fieldSource === "nav" && unmapped ? ` · ${unmapped} without FAA position` : "")
    );

    // Searching never hides fields: it zooms to the match (or frames a handful of them).
    lastHits = selection.hits;
    if (state.search !== lastSearch) {
      lastSearch = state.search;
      zoomToMatches(selection.hits, state.search);
    }

    // the sheet: a field, or an airspace area/route
    const field = state.selectedFieldId ? fields.find((f) => f.id === state.selectedFieldId) : null;
    let airspace = null;
    if (state.selectedAirspaceId) {
      airspace = planner.getAirspace(state.selectedAirspaceId);
      if (!airspace && airspaceLoadRequested !== state.selectedAirspaceId) {
        // arrived from a shared link: the area's file isn't loaded yet
        airspaceLoadRequested = state.selectedAirspaceId;
        planner.ensureAirspaceData(state.selectedAirspaceId).then(render).catch(() => {});
      }
    }
    const [y, m, d] = state.wxDay.split("-").map(Number);
    fieldPanel.render({ field, airspace, ctx: { origin, config, tripDate: new Date(y, m - 1, d), wxRows: field ? wx.fieldRows(field.code, state.wxDay) : null, stateTax: field ? stateTax?.states?.[field.state] : null, stateTaxAsOf: stateTax?.asOf, inTrip: field ? state.trip.some((x) => x.code === field.code) : false } });
  }

  function renderEvents(state) {
    if (eventsError) {
      filterRail.setCounts("Events failed to load");
      return;
    }
    if (!eventsPage) {
      filterRail.setCounts("Loading events…");
      return;
    }
    const counts = eventsPage.render(state);
    filterRail.setCounts(`${counts.placeCount} place${counts.placeCount === 1 ? "" : "s"} · ${counts.eventCount} event${counts.eventCount === 1 ? "" : "s"} in window`);
  }

  function render() {
    const state = store.getState();
    syncPage(state.view);
    filterRail.syncFromState(state);
    renderFreshness(state.view);
    checkFreshness(); // the forecast and TFR files arrive after boot and re-render the page

    // one-way DOM->store binding on the search input, so typing doesn't
    // fight the cursor
    if (document.activeElement !== searchInput && searchInput.value !== state.search) searchInput.value = state.search;

    if (state.originId !== currentOriginId) {
      currentOriginId = state.originId;
      planner.setOrigin(originsById.get(currentOriginId));
    }

    if (state.view === "planner") {
      eventsPage?.closeDetail();
      renderPlanner(state);
    } else if (state.view === "weekends") {
      fieldPanel.render({ field: null, airspace: null });
      filterRail.setCounts("Weekend picks within this range");
      weekendsPage.render(state);
    } else {
      fieldPanel.render({ field: null, airspace: null });
      renderEvents(state);
    }
  }

  store.subscribe(render);
  initUrlState(store, { originIds: new Set(config.origins.map((o) => o.id)), rangeMin: config.rangeSlider.min, rangeMax: config.rangeSlider.max });
  // A link can name a field that is gone from the list, under the runway cutoff or without a position. Drop those
  // once, here, so the legs on screen are exactly the stops in the state (buttons act on the leg they sit on).
  const known = (code) => fieldsByCode.get(code)?.hasPosition;
  if (store.getState().trip.some((x) => !known(x.code))) store.setState((st) => ({ trip: st.trip.filter((x) => known(x.code)) }));
  render();

  // The map container can report zero size if Leaflet initializes before the
  // CSS grid layout has settled — force a re-measure once layout is real.
  requestAnimationFrame(() => planner.invalidateSize());
  window.addEventListener("load", () => planner.invalidateSize());
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div style="padding:40px;color:#e65a5a;font-family:sans-serif;">
    <h2>Failed to load</h2><pre>${String(err.message).replace(/[<&]/g, "")}</pre>
  </div>`;
});
