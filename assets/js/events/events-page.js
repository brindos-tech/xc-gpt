// The events map (page 2): destinations near each base, with the events
// happening there in the chosen date range. Loaded lazily — the event file
// is the biggest download on the site, and the planner home page doesn't
// need any of it.
import { greatCircleNm, flightMinutes, legsRequired, planRoute } from "../geo.js";
import { applyFiltersMemoized } from "../filters.js";
import { createMapView } from "../views/map-view.js";
import { createScrubber } from "../views/scrubber.js";
import { createDetailPanel } from "../views/detail-panel.js";

export async function createEventsPage({ store, config, meta, loadJson }) {
  const [rawPlaces, events, weather] = await Promise.all([
    loadJson("curated/places.json"),
    loadJson("generated/events.json").catch(() => loadJson("curated/events.seed.json")),
    loadJson("generated/weather.json").catch(() => ({})),
  ]);

  const originsById = new Map(config.origins.map((o) => [o.id, o]));
  const fuelStopFields = rawPlaces.flatMap((p) => p.airports.filter((a) => a.vanceApproved));

  // Distance/flight-time/route all depend on which base the range is drawn
  // from, so this re-runs whenever the selected origin changes.
  function deriveFields(origin) {
    return rawPlaces.map((p) => {
      const distanceNm = greatCircleNm(origin, p);
      const legs = legsRequired(distanceNm, config.aircraft.legRangeNm);
      const route = legs > 1 ? planRoute(origin, p, fuelStopFields, config.aircraft.legRangeNm, config.aircraft.reserveNm) : null;
      return { ...p, distanceNm, flightMinutes: flightMinutes(distanceNm, config.aircraft.cruiseKts), legs, route };
    });
  }

  let currentOriginId = store.getState().originId;
  let places = deriveFields(originsById.get(currentOriginId));

  const mapView = createMapView({ config, origin: originsById.get(currentOriginId) });
  const scrubber = createScrubber({ store, config, allEvents: events });
  const detailPanel = createDetailPanel({ store, meta, config });

  // Captured *before* setState, because the same render pass also rebuilds
  // the map's pins — by the time anything downstream could read
  // document.activeElement, the focused element may already be gone. See
  // views/detail-panel.js for where this is used.
  let pendingFocusPlaceId = null;
  mapView.onPinClick((placeId) => {
    pendingFocusPlaceId = document.activeElement?.dataset?.place || null;
    store.setState({ selectedPlaceId: placeId });
  });

  /** Render for the current state; returns the counts for the rail. */
  function render(state) {
    if (state.originId !== currentOriginId) {
      currentOriginId = state.originId;
      places = deriveFields(originsById.get(currentOriginId));
      mapView.setOrigin(originsById.get(currentOriginId));
    }
    const filtered = applyFiltersMemoized(places, events, state, config);
    mapView.updateRange(state.rangeNm);
    mapView.render(filtered.visiblePlaces, places, state);
    scrubber.redraw(state);

    if (state.selectedPlaceId) {
      const place = places.find((p) => p.id === state.selectedPlaceId);
      const evs = filtered.eventsByPlace.get(state.selectedPlaceId) || [];
      detailPanel.render(place, evs, weather[state.selectedPlaceId], pendingFocusPlaceId);
    } else {
      detailPanel.render(null, []);
    }
    return filtered.counts;
  }

  return {
    render,
    invalidateSize: () => mapView.invalidateSize(),
    closeDetail: () => detailPanel.render(null, []),
  };
}
