import { greatCircleNm, flightMinutes, legsRequired, isWestOfMississippi, planRoute } from "./geo.js";
import { createStore } from "./store.js";
import { applyFiltersMemoized } from "./filters.js";
import { initUrlState } from "./url-state.js";
import { formatUpdatedAgo, decodeEntities } from "./format.js";
import { createMapView } from "./views/map-view.js";
import { createFilterRail } from "./views/filter-rail.js";
import { createScrubber } from "./views/scrubber.js";
import { renderFeed } from "./views/feed-view.js";
import { renderPlaces } from "./views/places-view.js";
import { renderArtists } from "./views/artists-view.js";
import { renderWeekends } from "./views/weekends-view.js";
import { createDetailPanel } from "./views/detail-panel.js";

const DATA_BASE = "data";

// Replaced with the deploy's commit SHA by scripts/stamp-version.js. Every
// data refresh is its own deploy, so the SHA changes exactly when the data
// does: repeat visits get a cheap 304 instead of re-downloading the event
// file, and a new deploy is never masked by a cached copy. Left unstamped
// (local dev), fall back to a fresh fetch every load.
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
  const [config, rawPlaces, artists, overrides, events, meta, weather] = await Promise.all([
    loadJson("curated/config.json"),
    loadJson("curated/places.json"),
    loadJson("curated/artists.json"),
    loadJson("curated/overrides.json"),
    loadJson("generated/events.json").catch(() => loadJson("curated/events.seed.json")),
    loadJson("generated/meta.json").catch(() => null),
    loadJson("generated/weather.json").catch(() => ({})),
  ]);

  // ---- derive place fields (computed, never authored — see ARCHITECTURE.md §5) ----
  // Distance/flight-time/route all depend on which base the range is drawn
  // from, so this has to be re-run (not computed once at boot) whenever the
  // selected origin changes — see the originId check in render() below.
  const originsById = new Map(config.origins.map((o) => [o.id, o]));
  const fuelStopFields = rawPlaces.flatMap((p) => p.airports.filter((a) => a.vanceApproved));
  function deriveFields(origin) {
    return rawPlaces.map((p) => {
      const distanceNm = greatCircleNm(origin, p);
      const legs = legsRequired(distanceNm, config.aircraft.legRangeNm);
      const route = legs > 1 ? planRoute(origin, p, fuelStopFields, config.aircraft.legRangeNm, config.aircraft.reserveNm) : null;
      return {
        ...p,
        distanceNm,
        flightMinutes: flightMinutes(distanceNm, config.aircraft.cruiseKts),
        legs,
        route,
        isWest: isWestOfMississippi(p, config.mississippi),
      };
    });
  }

  // The real current date, normalised to local midnight — not the build
  // date. This was pinned to a literal, which quietly turned the whole app
  // into a snapshot: "this weekend" and the 30/90-day presets all measure
  // from here, so they kept pointing at the window that was current when the
  // build shipped and let events that had already happened stay on screen.
  //
  // Midnight is load-bearing, not tidiness. Event dates parse to local
  // midnight (see parseDate) and the window test is
  // `evStart <= rangeEnd && evEnd >= rangeStart` — with a mid-afternoon
  // rangeStart, a single-day event happening *today* would test its own
  // midnight end against 14:00 and drop out of its own day.
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const store = createStore(config, today);
  let currentOriginId = store.getState().originId;
  let places = deriveFields(originsById.get(currentOriginId));

  // ---- freshness header ----
  const freshnessText = document.getElementById("freshnessText");
  const freshnessDot = document.getElementById("freshnessDot");
  if (meta && meta.buildAt) {
    // `now`, not `today`: freshness is an elapsed-hours measure, and against
    // a midnight-floored date a build from earlier the same day reads as
    // negative hours old.
    freshnessText.textContent = `Updated ${formatUpdatedAgo(meta.buildAt, now)}`;
    const hoursSince = (now - new Date(meta.buildAt)) / 3600000;
    freshnessDot.className = "source-dot " + (hoursSince < 72 ? "ok" : hoursSince < 168 ? "stale" : "error");
  } else {
    freshnessText.textContent = "Bootstrap data (no CI run yet)";
    freshnessDot.className = "source-dot stale";
  }

  // ---- views ----
  const mapView = createMapView({ config, origin: originsById.get(currentOriginId) });
  const filterRail = createFilterRail({ store, config });
  const scrubber = createScrubber({ store, config, allEvents: events });
  const detailPanel = createDetailPanel({ store, meta, config });

  // Captured *before* setState, because the very same render pass this
  // triggers also rebuilds the map's pins (and every list view redraws its
  // whole DOM too) — by the time anything downstream could read
  // document.activeElement, the element that was actually focused when the
  // user pressed Enter/clicked may already be gone, with focus reset to
  // <body>. See views/detail-panel.js for where this is used.
  let pendingFocusPlaceId = null;
  function captureFocusOrigin() {
    pendingFocusPlaceId = document.activeElement?.dataset?.place || null;
  }

  mapView.onPinClick((placeId) => {
    captureFocusOrigin();
    store.setState({ selectedPlaceId: placeId });
  });

  const panes = {
    map: document.getElementById("pane-map"),
    feed: document.getElementById("pane-feed"),
    places: document.getElementById("pane-places"),
    artists: document.getElementById("pane-artists"),
    weekends: document.getElementById("pane-weekends"),
  };
  const tabBar = document.getElementById("tabBar");

  // render() is the single place that reflects state.view onto the DOM
  // (pane visibility, tab highlight) — this function only requests the
  // change, so it works identically whether triggered by a click or by
  // restoring state from the URL hash on load.
  function switchView(view) {
    store.setState({ view });
  }

  let lastRenderedView = null;
  function syncViewPanes(view) {
    if (view === lastRenderedView) return;
    lastRenderedView = view;
    Object.entries(panes).forEach(([key, el]) => el.classList.toggle("active", key === view));
    tabBar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    if (view === "map") requestAnimationFrame(() => mapView.invalidateSize());
  }

  tabBar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (btn) switchView(btn.dataset.view);
  });

  // ---- search ----
  const searchInput = document.getElementById("globalSearch");
  let searchDebounce;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => store.setState({ search: searchInput.value }), 150);
  });

  function selectPlace(placeId, eventId) {
    captureFocusOrigin();
    store.setState({ selectedPlaceId: placeId, selectedEventId: eventId || null });
    const place = places.find((p) => p.id === placeId);
    if (place) mapView.flyTo(place.lat, place.lon);
  }

  // ---- main render loop ----
  function render() {
    const state = store.getState();

    if (state.originId !== currentOriginId) {
      currentOriginId = state.originId;
      places = deriveFields(originsById.get(currentOriginId));
      mapView.setOrigin(originsById.get(currentOriginId));
    }

    const filtered = applyFiltersMemoized(places, events, state, config);
    filtered.state = state;

    syncViewPanes(state.view);
    filterRail.syncFromState(state);
    filterRail.setCounts(filtered.counts.placeCount, filtered.counts.eventCount);

    // one-way DOM->store binding on the search input, so typing doesn't
    // fight the cursor — only pull a hash-restored value in when the field
    // isn't currently focused (i.e. not mid-keystroke).
    if (document.activeElement !== searchInput && searchInput.value !== state.search) {
      searchInput.value = state.search;
    }

    // west-of-river delta
    if (state.westOnly) {
      const withEast = places.filter((p) => p.distanceNm <= state.rangeNm);
      const eastCount = withEast.length - filtered.visiblePlaces.length;
      filterRail.setWestDelta(eastCount > 0 ? `+${eastCount} places east of the river if toggled off` : "");
    } else {
      filterRail.setWestDelta("");
    }

    mapView.updateRange(state.rangeNm);
    mapView.setRiverVisible(state.westOnly);
    mapView.render(filtered.visiblePlaces, places, state);

    if (state.westOnly) {
      const allInRange = places.filter((p) => p.distanceNm <= state.rangeNm);
      const eastPlaces = allInRange.filter((p) => !p.isWest);
      mapView.setRiverDelta(eastPlaces.length ? `+${eastPlaces.length} places east of the Mississippi hidden by the current rule` : "");
    } else {
      mapView.setRiverDelta("");
    }

    scrubber.redraw(state);

    if (state.view === "feed") renderFeed(document.getElementById("feedInner"), filtered, places, selectPlace);
    if (state.view === "places") renderPlaces(document.getElementById("placesInner"), filtered, config, selectPlace);
    if (state.view === "artists")
      renderArtists(document.getElementById("artistsInner"), filtered, { artists, meta, places }, selectPlace);
    if (state.view === "weekends")
      renderWeekends(document.getElementById("weekendsInner"), filtered, { places, config, overrides, weather }, selectPlace);

    if (state.selectedPlaceId) {
      const place = places.find((p) => p.id === state.selectedPlaceId);
      const evs = filtered.eventsByPlace.get(state.selectedPlaceId) || [];
      detailPanel.render(place, evs, weather[state.selectedPlaceId], pendingFocusPlaceId);
    } else {
      detailPanel.render(null, []);
    }
  }

  store.subscribe(render);
  initUrlState(store);
  render();

  // The map container can report zero size if Leaflet initializes before the
  // CSS grid layout has settled — force a re-measure once layout is real.
  requestAnimationFrame(() => mapView.invalidateSize());
  window.addEventListener("load", () => mapView.invalidateSize());
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div style="padding:40px;color:#e65a5a;font-family:sans-serif;">
    <h2>Failed to load</h2><pre>${err.message}</pre>
  </div>`;
});
