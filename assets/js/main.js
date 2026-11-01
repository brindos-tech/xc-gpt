import { createStore } from "./store.js";
import { initUrlState } from "./url-state.js";
import { formatUpdatedAgo, parseDate } from "./format.js";
import { createFilterRail } from "./views/filter-rail.js";
import { createPlannerView } from "./planner/planner-view.js";
import { createFieldPanel } from "./planner/field-panel.js";
import { mergeFields, selectFields } from "./planner/fields.js";
import { createWxController } from "./planner/wx-controller.js";
import { createComments } from "./planner/comments.js";

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
  const fields = mergeFields(navinfo, factsFile, aircard, approaches);

  // The real current date at local midnight — not the build date. Event
  // dates parse to local midnight, and the window test compares against it,
  // so a mid-afternoon "today" would drop a single-day event from its own day.
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const store = createStore(config, today);
  let currentOriginId = store.getState().originId;

  const $ = (id) => document.getElementById(id);
  const app = document.querySelector(".app");
  const panes = { planner: $("pane-planner"), events: $("pane-events") };
  const tabBar = $("tabBar");
  const searchInput = $("globalSearch");
  const freshnessText = $("freshnessText");
  const freshnessDot = $("freshnessDot");

  const filterRail = createFilterRail({ store, config });
  const fieldPanel = createFieldPanel({ store });
  const comments = createComments({ host: $("fieldComments"), apiBase: config.commentsApi, today });

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
  $("plannerLegend").innerHTML =
    planner.legendStatuses.map((s) => `<span><span class="legend-dot" style="background:${s.color}"></span>${s.label}</span>`).join("") +
    `<span class="legend-note">dashed = outside range (search result)</span>`;

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
    searchInput.placeholder = view === "planner" ? "Search fields, FBOs…" : "Search places, events…";
    // Leaflet measures 0×0 inside a hidden pane.
    requestAnimationFrame(() => (view === "planner" ? planner.invalidateSize() : eventsPage?.invalidateSize()));
    if (view === "events") ensureEventsPage();
  }

  // ---- render ----
  let lastSearch = "";
  let airspaceLoadRequested = null;

  function renderPlanner(state) {
    const origin = originsById.get(state.originId);
    planner.updateRange(state.rangeNm);
    const selection = selectFields(fields, state, origin, config);
    planner.renderFields(selection, state.selectedFieldId, wx.fieldRing);
    wx.render(state);
    planner.setAirspace(state.airspace, state.selectedAirspaceId);

    const label = state.fieldSource === "p" ? "P-coded" : "nav-list";
    const unmapped = fields.filter((f) => !f.hasPosition).length;
    filterRail.setCounts(
      `${selection.inRange} ${label} field${selection.inRange === 1 ? "" : "s"} in range` +
        (state.fieldSource === "nav" && unmapped ? ` · ${unmapped} without FAA position` : "")
    );

    // A search that narrows to one field: show it.
    if (state.search !== lastSearch) {
      lastSearch = state.search;
      if (state.search && selection.fields.length === 1) planner.flyTo(selection.fields[0].lat, selection.fields[0].lon);
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
    comments.show(field ? { subject: `field:${field.code}`, label: field.code } : airspace && airspace.type !== "TFR" ? { subject: `airspace:${airspace.id}`, label: airspace.name } : null);
    const [y, m, d] = state.tripDate.split("-").map(Number);
    fieldPanel.render({ field, airspace, ctx: { origin, config, tripDate: new Date(y, m - 1, d), wxRows: field ? wx.fieldRows(field.code, state.tripDate) : null, stateTax: field ? stateTax?.states?.[field.state] : null, stateTaxAsOf: stateTax?.asOf } });
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
    } else {
      comments.show(null);
      fieldPanel.render({ field: null, airspace: null });
      renderEvents(state);
    }
  }

  store.subscribe(render);
  initUrlState(store);
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
