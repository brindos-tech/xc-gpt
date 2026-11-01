// The "Trip" section of the planner rail: stops, legs, totals, per diem
// estimate, copy-route and print-crew-card buttons. Rendered from state on
// every planner render; all buttons are delegated from the one container.
import { tripLegs, routeString, tripPerDiem } from "../planner/trip.js";
import { formatFlightTime } from "../format.js";
import { esc } from "../planner/html.js";

const money = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

export function createTripPanel({ store, config, fieldsByCode, onPrint }) {
  const body = document.getElementById("tripBody");

  const update = (fn) => store.setState((s) => ({ trip: fn(s.trip.map((x) => ({ ...x }))) }));

  body.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-trip]");
    if (!t) return;
    const i = Number(t.dataset.i);
    switch (t.dataset.trip) {
      case "remove": return update((trip) => trip.filter((_, k) => k !== i));
      case "up": return update((trip) => (i > 0 ? (trip.splice(i - 1, 0, ...trip.splice(i, 1)), trip) : trip));
      case "down": return update((trip) => (i < trip.length - 1 ? (trip.splice(i + 1, 0, ...trip.splice(i, 1)), trip) : trip));
      case "clear": return store.setState({ trip: [] });
      case "print": return onPrint();
      case "copy": {
        const text = t.dataset.route;
        try {
          await navigator.clipboard.writeText(text);
          t.textContent = "Copied ✓";
        } catch {
          window.prompt("Copy the route:", text);
        }
        setTimeout(() => (t.textContent = "Copy route"), 1500);
        return;
      }
      case "select": return store.setState({ selectedFieldId: t.dataset.code, selectedAirspaceId: null });
    }
  });
  body.addEventListener("change", (e) => {
    const ron = e.target.closest("[data-trip-ron]");
    if (ron) return update((trip) => trip.map((s, k) => (k === Number(ron.dataset.i) ? { ...s, ron: ron.checked } : s)));
    if (e.target.closest("[data-trip-return]")) store.setState({ tripReturn: e.target.checked });
  });

  /** Resolve the state's stop codes to fields (unknown codes, e.g. from an old link, are dropped). */
  function resolve(state) {
    return state.trip.map((s) => ({ ...s, field: fieldsByCode.get(s.code) })).filter((s) => s.field?.hasPosition);
  }

  function render(state, origin) {
    const stops = resolve(state);
    if (!stops.length) {
      body.innerHTML = `<div class="rail-hint">Open a field and tap <b>Add to trip</b>. Stops get legs, flight time, a per diem estimate, a route string for ForeFlight and a printable crew card.</div>`;
      return { stops, legs: null };
    }
    const legs = tripLegs(origin, stops.map((s) => s.field), config, state.tripReturn);
    const [y, m, d] = state.tripDate.split("-").map(Number);
    const cost = tripPerDiem(stops, new Date(y, m - 1, d));
    const route = routeString(origin, stops.map((s) => s.field), state.tripReturn);
    body.innerHTML = `
      <ol class="trip-list">
        <li class="trip-base"><span>${esc(origin.icao)}</span><span class="muted small">start</span></li>
        ${stops
          .map((s, i) => {
            const leg = legs.legs[i];
            return `<li class="trip-stop">
              <div class="trip-main"><button type="button" class="cm-link" data-trip="select" data-code="${esc(s.code)}"><b>${esc(s.code)}</b></button> <span class="muted small">${esc(s.field.name)}</span></div>
              <div class="trip-meta muted small">${Math.round(leg.nm)} nm · ${formatFlightTime(leg.mins)}${leg.overRange ? ` · <span class="bad-text">beyond one leg (${config.aircraft.legRangeNm} nm)</span>` : ""}${s.field.fuel === "Not Approved" ? ` · <span class="bad-text">no fuel</span>` : s.field.fuel !== "Approved" ? ` · <span class="warn-text">fuel: see comments</span>` : ""}</div>
              <div class="trip-ctl">
                <label><input type="checkbox" data-trip-ron data-i="${i}" ${s.ron ? "checked" : ""}> RON</label>
                <button type="button" data-trip="up" data-i="${i}" aria-label="Move ${esc(s.code)} earlier" ${i === 0 ? "disabled" : ""}>↑</button>
                <button type="button" data-trip="down" data-i="${i}" aria-label="Move ${esc(s.code)} later" ${i === stops.length - 1 ? "disabled" : ""}>↓</button>
                <button type="button" data-trip="remove" data-i="${i}" aria-label="Remove ${esc(s.code)}">×</button>
              </div></li>`;
          })
          .join("")}
        ${state.tripReturn ? `<li class="trip-base"><span>${esc(origin.icao)}</span><span class="muted small">${Math.round(legs.legs.at(-1).nm)} nm · ${formatFlightTime(legs.legs.at(-1).mins)}${legs.legs.at(-1).overRange ? ` · <span class="bad-text">beyond one leg</span>` : ""}</span></li>` : ""}
      </ol>
      <label class="trip-return"><input type="checkbox" data-trip-return ${state.tripReturn ? "checked" : ""}> Return to ${esc(origin.icao)}</label>
      <div class="trip-total"><b>${Math.round(legs.totalNm)} nm</b> · <b>${formatFlightTime(legs.totalMins)}</b> flying · ${legs.legs.length} leg${legs.legs.length === 1 ? "" : "s"}</div>
      <div class="trip-cost small">${cost.nights ? `${cost.nights} night${cost.nights === 1 ? "" : "s"} · lodging ${money(cost.lodging)} + M&amp;IE ${money(cost.meals)} = <b>${money(cost.total)}</b> <span class="muted">(GSA estimate${cost.missing.length ? `; no rate for ${esc(cost.missing.join(", "))}` : ""})</span>` : `<span class="muted">No RON stops, so no per diem counted.</span>`}</div>
      <div class="trip-actions">
        <button type="button" class="chip" data-trip="copy" data-route="${esc(route)}">Copy route</button>
        <button type="button" class="chip" data-trip="print">Print crew card</button>
        <button type="button" class="chip" data-trip="clear">Clear</button>
      </div>
      <div class="rail-hint">${esc(route)}</div>`;
    return { stops, legs, cost, route };
  }

  return { render, resolve };
}
