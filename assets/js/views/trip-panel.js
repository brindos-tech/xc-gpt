// The "Trip" section of the planner rail: stops, legs, totals, per diem
// estimate, copy-route and print-crew-card buttons. Rendered from state on
// every planner render; all buttons are delegated from the one container.
import { tripLegs, routeString, tripPerDiem, scheduleTrip, legFlags } from "../planner/trip.js";
import { zoneAbbr, clock, zulu, tzLabel, clockShift } from "../planner/sun.js";
import { CAT_NAMES, CAT_COLORS, flightCategory, ceilingText } from "../planner/wx-model.js";
import { formatFlightTime } from "../format.js";
import { esc } from "../planner/html.js";
import { matchesSearch } from "../planner/fields.js";
import { greatCircleNm } from "../geo.js";

const money = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

export function createTripPanel({ store, config, fieldsByCode, getOrigin, onPrint, forecastAt }) {
  const body = document.getElementById("tripBody");
  const search = document.getElementById("tripSearch");
  const suggest = document.getElementById("tripSuggest");
  let active = -1;
  let shown = [];

  /** Fields matching the box, best first: exact code, code prefix, then nearest to the base. Already-chosen stops are left out. */
  function suggestions(q) {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const origin = getOrigin();
    const chosen = new Set(store.getState().trip.map((x) => x.code));
    const rank = (f) => (f.code.toLowerCase() === query || f.faaId?.toLowerCase() === query ? 0 : f.code.toLowerCase().startsWith(query) ? 1 : f.name.toLowerCase().startsWith(query) ? 2 : 3);
    return [...fieldsByCode.values()]
      .filter((f) => f.hasPosition && !chosen.has(f.code) && matchesSearch(f, q))
      .map((f) => ({ f, r: rank(f), d: greatCircleNm(origin, f) }))
      .sort((a, b) => a.r - b.r || a.d - b.d)
      .slice(0, 7);
  }

  function showSuggestions() {
    shown = suggestions(search.value);
    active = shown.length ? 0 : -1;
    suggest.hidden = !shown.length;
    search.setAttribute("aria-expanded", String(shown.length > 0));
    suggest.innerHTML = shown
      .map(({ f, d }, i) => `<li role="option" id="tripSug${i}" data-code="${esc(f.code)}" aria-selected="${i === active}" class="${i === active ? "active" : ""}"><b>${esc(f.code)}</b> <span>${esc(f.name)}</span><small class="muted">${esc(f.city)} · ${Math.round(d)} nm</small></li>`)
      .join("");
  }

  function addStop(code) {
    store.setState((s) => (s.trip.some((x) => x.code === code) ? {} : { trip: [...s.trip, { code, ron: false }] }));
    search.value = "";
    showSuggestions();
    search.focus();
  }

  search.addEventListener("input", showSuggestions);
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!shown.length) return;
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      suggest.querySelectorAll("li").forEach((li, i) => {
        li.classList.toggle("active", i === active);
        li.setAttribute("aria-selected", String(i === active));
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active]) addStop(shown[active].f.code);
    } else if (e.key === "Escape") {
      search.value = "";
      showSuggestions();
    }
  });
  // mousedown, not click: the input's blur would close the list before a click lands
  suggest.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-code]");
    if (li) {
      e.preventDefault();
      addStop(li.dataset.code);
    }
  });
  search.addEventListener("blur", () => setTimeout(() => ((suggest.hidden = true), search.setAttribute("aria-expanded", "false")), 120));
  search.addEventListener("focus", () => search.value && showSuggestions());

  const update = (fn) => store.setState((s) => ({ trip: fn(s.trip.map((x) => ({ ...x }))) }));

  body.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-trip]");
    if (!t) return;
    const i = Number(t.dataset.i);
    switch (t.dataset.trip) {
      case "remove": return update((trip) => trip.filter((_, k) => k !== i));
      case "up": return update((trip) => (i > 0 ? (trip.splice(i - 1, 0, ...trip.splice(i, 1)), trip) : trip));
      case "down": return update((trip) => (i < trip.length - 1 ? (trip.splice(i + 1, 0, ...trip.splice(i, 1)), trip) : trip));
      case "clear": return store.setState({ trip: [], tripReturnDep: "" });
      case "reset-dep": return setDeparture(i, "");
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
    if (e.target.closest("[data-trip-return]")) return store.setState({ tripReturn: e.target.checked });
    const dep = e.target.closest("[data-trip-dep]");
    if (dep) setDeparture(Number(dep.dataset.i), dep.value);
  });

  /** Set (or with "" clear) the takeoff time of leg `i`. Leg 1's date is the trip date, so changing it moves the day. */
  function setDeparture(i, value) {
    const s = store.getState();
    const patch = {};
    if (i >= s.trip.length) patch.tripReturnDep = value;
    else patch.trip = s.trip.map((x, k) => (k === i ? { ...x, dep: value || undefined } : { ...x }));
    if (i === 0 && /^\d{4}-\d{2}-\d{2}T/.test(value)) patch.tripDate = value.slice(0, 10);
    store.setState(patch);
  }

  /** Resolve the state's stop codes to fields (unknown codes, e.g. from an old link, are dropped). */
  function resolve(state) {
    return state.trip.map((s) => ({ ...s, field: fieldsByCode.get(s.code) })).filter((s) => s.field?.hasPosition);
  }

  /** Everything derived from the trip: legs, schedule, per diem, route. */
  function compute(state, origin) {
    const stops = resolve(state);
    if (!stops.length) return { stops, legs: null };
    const fieldsList = stops.map((s) => s.field);
    const legs = tripLegs(origin, fieldsList, config, state.tripReturn);
    const schedule = scheduleTrip({ origin, stops, legs: legs.legs, tripDate: state.tripDate, returnDep: state.tripReturnDep });
    // each night's lodging rate comes from the month of the night it is spent
    const nights = stops.map((s, i) => ({ ...s, date: s.ron ? new Date(...schedule[i].etaLocal.date.split("-").map((n, k) => (k === 1 ? Number(n) - 1 : Number(n)))) : undefined }));
    const [y, m, d] = state.tripDate.split("-").map(Number);
    return { stops, legs, schedule, cost: tripPerDiem(nights, new Date(y, m - 1, d)), route: routeString(origin, fieldsList, state.tripReturn) };
  }

  const wxChip = (code, instant) => {
    const f = forecastAt?.(code, instant);
    if (!f) return "";
    const cat = flightCategory(f.ceil, f.vis);
    const ice = f.lice || f.hice ? ` · icing ${Math.max(f.lice, f.hice) === 2 ? "likely" : "possible"}` : "";
    return `<span class="trip-wx" style="--c:${CAT_COLORS[cat]}">${CAT_NAMES[cat]} · ceiling ${esc(ceilingText(f.ceil))}${f.thun ? " · thunderstorms" : ""}${ice}</span>`;
  };

  /** One leg's schedule block: takeoff picker, arrival, forecast and flags. */
  function legHtml(leg, state, flightLine) {
    const flags = legFlags(leg).map((x) => `<div class="fp-flag ${x.level}">⚠ ${esc(x.text)}</div>`).join("");
    const takeoff = `${leg.depLocal.date}T${leg.depLocal.time}`;
    const shift = clockShift(leg.fromTz, leg.dep, leg.toTz, leg.eta);
    return `<div class="trip-leg">
      <div class="trip-leg-line muted small">Leg ${leg.i + 1}: ${esc(leg.from)} → ${esc(leg.to)} · ${flightLine}</div>
      <label class="trip-dep">Takeoff <input type="datetime-local" step="300" data-trip-dep data-i="${leg.i}" value="${takeoff}" aria-label="Takeoff, leg ${leg.i + 1}, ${esc(leg.from)} local time"> <span class="muted small">${esc(leg.from)} time (${esc(zoneAbbr(leg.dep, leg.fromTz))}) · ${esc(zulu(leg.dep).time)}</span>${leg.explicit && leg.i > 0 ? ` <button type="button" class="cm-link small" data-trip="reset-dep" data-i="${leg.i}">auto</button>` : ""}</label>
      <div class="trip-arr small">Lands ${esc(clock(leg.eta, leg.toTz))} ${esc(zoneAbbr(leg.eta, leg.toTz))} · ${esc(zulu(leg.eta).time)} at ${esc(leg.to)}${leg.etaLocal.date !== leg.depLocal.date ? ` <span class="muted">(${esc(new Date(leg.eta).toLocaleDateString("en-US", { timeZone: leg.toTz, weekday: "short", month: "short", day: "numeric" }))})</span>` : ""}</div>
      ${shift.text ? `<div class="fp-flag info">🕐 ${esc(shift.text)}</div>` : ""}
      <div class="trip-wxrow small">${wxChip(leg.from, leg.dep) ? `<span class="muted">takeoff</span> ${wxChip(leg.from, leg.dep)}` : ""} ${wxChip(leg.to, leg.eta) ? `<span class="muted">landing</span> ${wxChip(leg.to, leg.eta)}` : ""}</div>
      ${flags}
    </div>`;
  }

  function render(state, origin) {
    const c = compute(state, origin);
    const { stops, legs, schedule, cost, route } = c;
    if (!stops.length) {
      body.innerHTML = `<div class="rail-hint">Type a field above to add it, or open any field on the map and tap <b>Add to trip</b>. Stops get legs, takeoff times you can set, flight time, a per diem estimate, a route string for ForeFlight and a printable crew card.</div>`;
      return c;
    }
    const flightLine = (leg) => `${Math.round(leg.nm)} nm · ${formatFlightTime(leg.mins)}${leg.overRange ? ` · <span class="bad-text">beyond one leg (${config.aircraft.legRangeNm} nm)</span>` : ""}`;
    body.innerHTML = `
      <ol class="trip-list">
        <li class="trip-base"><span>${esc(origin.icao)}</span><span class="muted small">start</span></li>
        ${stops
          .map((s, i) => `<li class="trip-stop">
              ${legHtml(schedule[i], state, flightLine(legs.legs[i]))}
              <div class="trip-main"><button type="button" class="cm-link" data-trip="select" data-code="${esc(s.code)}"><b>${esc(s.code)}</b></button> <span class="muted small">${esc(s.field.name)}</span>${s.field.fuel === "Not Approved" ? ` <span class="bad-text small">no fuel</span>` : s.field.fuel !== "Approved" ? ` <span class="warn-text small">fuel: see comments</span>` : ""}</div>
              <div class="trip-ctl">
                <label><input type="checkbox" data-trip-ron data-i="${i}" ${s.ron ? "checked" : ""}> RON</label>
                <button type="button" data-trip="up" data-i="${i}" aria-label="Move ${esc(s.code)} earlier" ${i === 0 ? "disabled" : ""}>↑</button>
                <button type="button" data-trip="down" data-i="${i}" aria-label="Move ${esc(s.code)} later" ${i === stops.length - 1 ? "disabled" : ""}>↓</button>
                <button type="button" data-trip="remove" data-i="${i}" aria-label="Remove ${esc(s.code)}">×</button>
              </div></li>`)
          .join("")}
        ${state.tripReturn ? `<li class="trip-stop trip-ret">${legHtml(schedule.at(-1), state, flightLine(legs.legs.at(-1)))}<div class="trip-main"><b>${esc(origin.icao)}</b> <span class="muted small">return</span></div></li>` : ""}
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
    return c;
  }

  return { render, resolve, compute };
}
