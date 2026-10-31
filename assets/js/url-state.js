// Bidirectional state <-> location.hash, so a link fully reproduces a view.
import { toDateKey, parseDate } from "./format.js";

export function stateToHash(state) {
  const params = new URLSearchParams();
  params.set("v", state.view);
  params.set("from", toDateKey(state.dateRange.start));
  params.set("to", toDateKey(state.dateRange.end));
  params.set("origin", state.originId);
  params.set("r", String(state.rangeNm));
  if (state.categories.size) params.set("cat", Array.from(state.categories).join(","));
  if (state.activities.size) params.set("act", Array.from(state.activities).join(","));
  if (state.search) params.set("q", state.search);
  if (state.selectedPlaceId) params.set("place", state.selectedPlaceId);
  // planner
  if (state.fieldSource !== "nav") params.set("src", state.fieldSource);
  if (state.fieldFilters.size) params.set("ff", Array.from(state.fieldFilters).join(","));
  params.set("air", Array.from(state.airspace).join(","));
  if (state.selectedFieldId) params.set("fld", state.selectedFieldId);
  if (state.selectedAirspaceId) params.set("as", state.selectedAirspaceId);
  if (state.tripDate) params.set("day", state.tripDate);
  return `#/${params.toString()}`;
}

export function hashToState(hash, defaults) {
  const clean = hash.replace(/^#\/?/, "");
  const params = new URLSearchParams(clean);
  const patch = {};

  if (params.has("v")) {
    // Pages that no longer exist (feed, places, artists, weekend recs) and
    // the old "map" name all land on the events page.
    const v = params.get("v");
    patch.view = v === "planner" ? "planner" : "events";
  }
  if (params.has("from")) patch.dateRange = { ...defaults.dateRange, start: parseDate(params.get("from")) };
  if (params.has("to")) {
    patch.dateRange = { ...(patch.dateRange || defaults.dateRange), end: parseDate(params.get("to")) };
  }
  // A link's date window is worth restoring — that's the point of a
  // shareable URL — but only while it still means anything. The hash is
  // rewritten on every state change, so every bookmark and reopened tab
  // carries whatever window was current when it was saved; restoring one
  // that has already fully elapsed just replays a dead range of past
  // events. Drop it and keep the fresh default. A window still running, or
  // one deliberately pointed at the future, restores as before.
  if (patch.dateRange?.end && defaults.today && patch.dateRange.end < defaults.today) {
    delete patch.dateRange;
  }

  if (params.has("origin")) patch.originId = params.get("origin");
  if (params.has("r")) patch.rangeNm = Number(params.get("r"));
  if (params.has("cat")) patch.categories = new Set(params.get("cat").split(",").filter(Boolean));
  if (params.has("act")) patch.activities = new Set(params.get("act").split(",").filter(Boolean));
  if (params.has("q")) patch.search = params.get("q");
  if (params.has("place")) patch.selectedPlaceId = params.get("place");
  if (params.has("src")) patch.fieldSource = params.get("src") === "p" ? "p" : "nav";
  if (params.has("ff")) patch.fieldFilters = new Set(params.get("ff").split(",").filter(Boolean));
  if (params.has("air")) patch.airspace = new Set(params.get("air").split(",").filter(Boolean));
  if (params.has("fld")) patch.selectedFieldId = params.get("fld");
  if (params.has("as")) patch.selectedAirspaceId = params.get("as");
  if (params.has("day") && /^\d{4}-\d{2}-\d{2}$/.test(params.get("day"))) patch.tripDate = params.get("day");

  return patch;
}

export function initUrlState(store) {
  if (window.location.hash && window.location.hash.length > 3) {
    const patch = hashToState(window.location.hash, store.getState());
    store.setState(patch);
  }

  // setTimeout, not requestAnimationFrame — this is background bookkeeping,
  // not a paint-timed update, and rAF can be suspended entirely in a
  // backgrounded/non-visible tab, silently freezing the URL out of sync.
  let replaceQueued = false;
  store.subscribe((state) => {
    if (replaceQueued) return;
    replaceQueued = true;
    setTimeout(() => {
      replaceQueued = false;
      const hash = stateToHash(state);
      if (hash !== window.location.hash) {
        history.replaceState(null, "", hash);
      }
    }, 0);
  });
}
