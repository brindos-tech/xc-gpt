// Bidirectional state <-> location.hash, so a link fully reproduces a view.
import { toDateKey, parseDate } from "./format.js";
import { encodeTrip, decodeTrip, encodeDep, decodeDep, isValidDate } from "./planner/trip.js";

export function stateToHash(state) {
  const params = new URLSearchParams();
  params.set("v", state.view);
  params.set("from", toDateKey(state.dateRange.start));
  params.set("to", toDateKey(state.dateRange.end));
  params.set("origin", state.originId);
  params.set("r", String(state.rangeNm));
  if (state.categories.size) params.set("cat", Array.from(state.categories).join(","));
  if (state.search) params.set("q", state.search);
  if (state.selectedPlaceId) params.set("place", state.selectedPlaceId);
  // planner
  if (state.fieldSource !== "nav") params.set("src", state.fieldSource);
  if (state.trip?.length) params.set("trip", encodeTrip(state.trip));
  if (state.tripReturn === false) params.set("ret", "0");
  if (state.tripReturnDep) params.set("rdep", encodeDep(state.tripReturnDep));
  if (state.approachTypes?.size) params.set("app", Array.from(state.approachTypes).join(","));
  params.set("air", Array.from(state.airspace).join(","));
  if (state.selectedFieldId) params.set("fld", state.selectedFieldId);
  if (state.selectedAirspaceId) params.set("as", state.selectedAirspaceId);
  if (state.tripDate) params.set("day", state.tripDate);
  if (state.wxDay && state.wxDay !== state.tripDate) params.set("wd", state.wxDay);
  params.set("wx", state.wxLayers.size ? Array.from(state.wxLayers).join(",") : "none");
  if (state.wxTime) params.set("wxt", state.wxTime);
  return `#/${params.toString()}`;
}

/**
 * @param {object} defaults the state to fall back on (and `today`, to drop dates that are over)
 * @param {{originIds?:Set<string>, rangeMin?:number, rangeMax?:number}} [limits] what this build accepts; a value
 *   outside them is ignored rather than loaded, so a garbled or old link opens the default view instead of breaking the page
 */
export function hashToState(hash, defaults, limits = {}) {
  const clean = hash.replace(/^#\/?/, "");
  const params = new URLSearchParams(clean);
  const patch = {};

  if (params.has("v")) {
    // Pages that no longer exist (feed, places, artists, weekend recs) and
    // the old "map" name all land on the events page.
    const v = params.get("v");
    patch.view = v === "planner" || v === "weekends" ? v : v === "reviews" ? "planner" : "events"; // the Reviews page is gone for now: old links land on the planner
  }
  if (isValidDate(params.get("from"))) patch.dateRange = { ...defaults.dateRange, start: parseDate(params.get("from")) };
  if (isValidDate(params.get("to"))) {
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

  if (params.has("origin") && (!limits.originIds || limits.originIds.has(params.get("origin")))) patch.originId = params.get("origin");
  if (params.has("r")) {
    const r = Number(params.get("r"));
    if (Number.isFinite(r) && r >= (limits.rangeMin ?? 0) && r <= (limits.rangeMax ?? Infinity)) patch.rangeNm = r;
  }
  if (params.has("cat")) patch.categories = new Set(params.get("cat").split(",").filter(Boolean));
  if (params.has("q")) patch.search = params.get("q");
  if (params.has("place")) patch.selectedPlaceId = params.get("place");
  if (params.has("src")) patch.fieldSource = params.get("src") === "p" ? "p" : "nav";
  if (params.has("trip")) patch.trip = decodeTrip(params.get("trip"));
  if (params.get("ret") === "0") patch.tripReturn = false;
  if (params.has("rdep")) patch.tripReturnDep = decodeDep(params.get("rdep"));
  if (params.has("app")) patch.approachTypes = new Set(params.get("app").split(",").filter(Boolean));
  if (params.has("air")) patch.airspace = new Set(params.get("air").split(",").filter(Boolean));
  if (params.has("fld")) patch.selectedFieldId = params.get("fld");
  if (params.has("as")) patch.selectedAirspaceId = params.get("as");
  // a trip or weather day that has already passed means nothing to a new visitor: keep today
  const upcoming = (str) => isValidDate(str) && (!defaults.today || parseDate(str) >= defaults.today);
  if (upcoming(params.get("day"))) {
    patch.tripDate = params.get("day");
    patch.wxDay = patch.tripDate; // links made before the weather day was separate
  }
  if (upcoming(params.get("wd"))) patch.wxDay = params.get("wd");
  if (params.has("wx")) patch.wxLayers = new Set(params.get("wx").split(",").filter((k) => k && k !== "none"));
  if (params.has("wxt") && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(params.get("wxt"))) patch.wxTime = params.get("wxt");

  return patch;
}

export function initUrlState(store, limits = {}) {
  if (window.location.hash && window.location.hash.length > 3) {
    const patch = hashToState(window.location.hash, store.getState(), limits);
    store.setState(patch);
  }

  // setTimeout, not requestAnimationFrame — this is background bookkeeping,
  // not a paint-timed update, and rAF can be suspended entirely in a
  // backgrounded/non-visible tab, silently freezing the URL out of sync.
  // The state is read when the timer fires, so a change made in the same
  // moment as another is never left out of the address.
  let replaceQueued = false;
  store.subscribe(() => {
    if (replaceQueued) return;
    replaceQueued = true;
    setTimeout(() => {
      replaceQueued = false;
      const hash = stateToHash(store.getState());
      if (hash !== window.location.hash) {
        history.replaceState(null, "", hash);
      }
    }, 0);
  });
}
