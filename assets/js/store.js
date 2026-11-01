// Minimal state container. No framework, no two-way binding.
import { DEFAULT_AIRSPACE } from "./planner/airspace.js";
import { toDateKey } from "./format.js";
import { DEFAULT_WX } from "./planner/wx-controller.js";

function defaultState(config, today) {
  const horizonEnd = new Date(today);
  horizonEnd.setDate(horizonEnd.getDate() + (config.defaults.horizonDays || 45));
  return {
    today,
    dateRange: { start: today, end: horizonEnd },
    originId: config.defaultOriginId,
    rangeNm: config.defaults.rangeNm,
    categories: new Set(),
    activities: new Set(),
    minScale: null, // null = no floor; show everything in range
    search: "",
    // "planner" (nav-info fields, the home page) | "events" (the events map)
    view: "planner",
    selectedPlaceId: null,
    selectedEventId: null,
    // ---- planner ----
    fieldSource: "nav", // "nav" = Vance Nav Info List, "p" = P-coded fields
    fieldFilters: new Set(), // keys of FIELD_FILTERS (assets/js/planner/fields.js)
    approachTypes: new Set(), // training filter: fields that have ALL of these approach types
    airspace: new Set(DEFAULT_AIRSPACE),
    selectedFieldId: null,
    selectedAirspaceId: null,
    tripDate: toDateKey(today), // day of travel: drives weather, per diem month and hotel dates
    wxLayers: new Set(DEFAULT_WX), // weather overlays on the planner map (empty = off)
    wxTime: null, // ISO UTC step picked on the slider; null = default for the day
  };
}

export function createStore(config, today = new Date()) {
  let state = defaultState(config, today);
  const listeners = new Set();
  let notifyQueued = false;

  function notify() {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      for (const fn of listeners) fn(state);
    });
  }

  return {
    getState() {
      return state;
    },
    setState(patch) {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      notify();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    reset() {
      state = defaultState(config, state.today);
      notify();
    },
  };
}
