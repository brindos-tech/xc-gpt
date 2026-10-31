// Minimal state container. No framework, no two-way binding.
import { DEFAULT_AIRSPACE } from "./planner/airspace.js";
import { toDateKey } from "./format.js";

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
    airspace: new Set(DEFAULT_AIRSPACE),
    selectedFieldId: null,
    selectedAirspaceId: null,
    tripDate: toDateKey(today), // day of travel: per diem month now, weather overlays next
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
