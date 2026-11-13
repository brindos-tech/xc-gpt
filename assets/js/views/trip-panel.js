// The "Trip" section of the planner rail: stops, legs, totals, per diem
// estimate, the route and print-crew-card buttons. Rendered from state on
// every planner render; all buttons are delegated from the one container.
import { tripLegs, routeString, tripPerDiem, scheduleTrip, legFlags, neighbourCodes } from "../planner/trip.js";
import { zoneAbbr, clock, zulu, tzLabel, clockShift } from "../planner/sun.js";
import { CAT_NAMES, CAT_COLORS, flightCategory, ceilingText } from "../planner/wx-model.js";
import { formatFlightTime } from "../format.js";
import { esc } from "../planner/html.js";
import { matchesSearch } from "../planner/fields.js";
import { greatCircleNm } from "../geo.js";
import { ceilingSeries, legIsInstrument, worstSample, summarize, timelineSvg, alternateCheck, alternateReason } from "../planner/ceiling-timeline.js";

const money = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

export function createTripPanel({ store, config, fieldsByCode, getOrigin, onPrint, forecastAt }) {
  const body = document.getElementById("tripBody");
  const search = document.getElementById("tripSearch");
  const suggest = document.getElementById("tripSuggest");
  let active = -1;
  let shown = [];

  const addBox = suggest.parentElement;
  const addLabel = document.getElementById("tripAddLabel");

  /** The fields a stop at position `i` must not be (its neighbours); a field may appear more than once in a plan. */
  const avoidFor = (i) => {
    const st = store.getState();
    return neighbourCodes(st.trip, i, st.tripReturn, getOrigin().icao);
  };

  /** Fields matching the box, best first: exact code, code prefix, then nearest to the base. `avoid` leaves out the neighbouring stops. */
  function suggestions(q, avoid = new Set()) {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const origin = getOrigin();
    const chosen = avoid;
    const rank = (f) => (f.code.toLowerCase() === query || f.faaId?.toLowerCase() === query ? 0 : f.code.toLowerCase().startsWith(query) ? 1 : f.name.toLowerCase().startsWith(query) ? 2 : 3);
    return [...fieldsByCode.values()]
      .filter((f) => f.hasPosition && !chosen.has(f.code) && matchesSearch(f, q))
      .map((f) => ({ f, r: rank(f), d: greatCircleNm(origin, f) }))
      .sort((a, b) => a.r - b.r || a.d - b.d)
      .slice(0, 7);
  }

  // One suggestion list serves the "add a leg" box and every leg's arrival
  // field: `current` is the input it is serving and `onPick` what a choice does.
  let current = null;
  let onPick = null;
  let openTimelines = new Set();

  function showSuggestions(input, pick, avoid) {
    current = input;
    onPick = pick;
    // the list sits under whichever input is being typed in
    (input.closest(".trip-combo") || addBox).appendChild(suggest);
    shown = suggestions(input.value, avoid);
    active = shown.length ? 0 : -1;
    suggest.hidden = !shown.length;
    input.setAttribute("aria-expanded", String(shown.length > 0));
    suggest.innerHTML = shown
      .map(({ f, d }, i) => `<li role="option" id="tripSug${i}" data-code="${esc(f.code)}" aria-selected="${i === active}" class="${i === active ? "active" : ""}"><b>${esc(f.code)}</b> <span>${esc(f.name)}</span><small class="muted">${esc(f.city)} · ${Math.round(d)} nm</small></li>`)
      .join("");
  }

  function hideSuggestions() {
    suggest.hidden = true;
    current?.setAttribute("aria-expanded", "false");
  }

  function pickSuggestion(code) {
    const input = current;
    const pick = onPick;
    hideSuggestions();
    if (input !== search) Object.assign(input, { value: code }).dataset.code = code; // no longer a half-typed edit: let the re-render through
    pick(code);
    if (input === search) {
      search.value = "";
      search.focus();
    }
  }

  function comboKeys(e, input, pick) {
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
      if (shown[active]) pickSuggestion(shown[active].f.code);
    } else if (e.key === "Escape") {
      if (input === search) input.value = "";
      else input.value = input.dataset.code || "";
      hideSuggestions();
    }
  }

  const addStop = (code) => store.setState((s) => (neighbourCodes(s.trip, s.trip.length, s.tripReturn, getOrigin().icao).has(code) ? {} : { trip: [...s.trip, { code, ron: false }] }));
  const changeStop = (i, code) => store.setState((s) => (s.trip[i] && !neighbourCodes(s.trip, i, s.tripReturn, getOrigin().icao).has(code) ? { trip: s.trip.map((x, k) => (k === i ? { ...x, code } : { ...x })) } : {}));

  search.addEventListener("input", () => showSuggestions(search, addStop, avoidFor(store.getState().trip.length)));
  search.addEventListener("keydown", (e) => comboKeys(e, search, addStop));
  search.addEventListener("focus", () => search.value && showSuggestions(search, addStop, avoidFor(store.getState().trip.length)));
  search.addEventListener("blur", () => setTimeout(() => current === search && hideSuggestions(), 120));

  // arrival fields inside the legs (delegated: they are re-rendered with the plan)
  const arrPick = (input) => (code) => changeStop(Number(input.dataset.i), code);
  body.addEventListener("focusin", (e) => e.target.matches?.("[data-trip-arr]") && e.target.select());
  body.addEventListener("input", (e) => e.target.matches?.("[data-trip-arr]") && showSuggestions(e.target, arrPick(e.target), avoidFor(Number(e.target.dataset.i))));
  body.addEventListener("keydown", (e) => e.target.matches?.("[data-trip-arr]") && comboKeys(e, e.target, arrPick(e.target)));
  body.addEventListener("focusout", (e) => {
    const input = e.target;
    if (!input.matches?.("[data-trip-arr]")) return;
    setTimeout(() => {
      if (current === input) hideSuggestions();
      if (input.isConnected && document.activeElement !== input) input.value = input.dataset.code; // abandoned edit
    }, 120);
  });

  // mousedown, not click: the input's blur would close the list before a click lands
  suggest.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-code]");
    if (li) {
      e.preventDefault();
      pickSuggestion(li.dataset.code);
    }
  });

  const update = (fn) => store.setState((s) => ({ trip: fn(s.trip.map((x) => ({ ...x }))) }));

  body.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-trip]");
    if (!t) return;
    const i = Number(t.dataset.i);
    switch (t.dataset.trip) {
      case "remove-return": return store.setState({ tripReturn: false });
      case "add-return": return store.setState({ tripReturn: true });
      case "remove": return update((trip) => trip.filter((_, k) => k !== i));
      case "up": return update((trip) => (i > 0 ? (trip.splice(i - 1, 0, ...trip.splice(i, 1)), trip) : trip));
      case "down": return update((trip) => (i < trip.length - 1 ? (trip.splice(i + 1, 0, ...trip.splice(i, 1)), trip) : trip));
      case "clear": return store.setState({ trip: [], tripReturnDep: "" });
      case "reset-dep": return setDeparture(i, "");
      case "print": return onPrint();
      case "select": return store.setState({ selectedFieldId: t.dataset.code, selectedAirspaceId: null });
    }
  });
  body.addEventListener("change", (e) => {
    if (e.target.closest("[data-trip-return]")) return store.setState({ tripReturn: e.target.checked });
    const base = e.target.closest("[data-trip-base]");
    if (base) return store.setState({ originId: base.value, fieldSource: base.value === config.defaultOriginId ? "nav" : "p" }); // same switch as the base chips
    const dep = e.target.closest("[data-trip-dep]");
    if (dep) setDeparture(Number(dep.dataset.i), dep.value);
  });

  /** Set (or with "" clear) the takeoff time of leg `i`. Leg 1's date is the trip date, so changing it moves the day. */
  function setDeparture(i, value) {
    const s = store.getState();
    const patch = {};
    if (i >= s.trip.length) patch.tripReturnDep = value;
    else patch.trip = s.trip.map((x, k) => (k === i ? { ...x, dep: value || undefined } : { ...x }));
    if (i === 0 && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      patch.tripDate = value.slice(0, 10);
      patch.wxDay = patch.tripDate; // look at the weather for the day you just set
    }
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
    // a stop is a RON when the next leg takes off on a later day; each night's lodging rate comes from the month of that night
    const overnights = stops.map((s, i) => ({ ...s, ron: schedule[i].ron, nights: schedule[i].nights, date: schedule[i].ron ? new Date(...schedule[i].etaLocal.date.split("-").map((n, k) => (k === 1 ? Number(n) - 1 : Number(n)))) : undefined }));
    const [y, m, d] = state.tripDate.split("-").map(Number);
    return { stops: overnights, legs, schedule, cost: tripPerDiem(overnights, new Date(y, m - 1, d)), route: routeString(origin, fieldsList, state.tripReturn) };
  }

  // VFR just says VFR; anything worse carries its ceiling
  const wxChip = (code, instant) => {
    const f = forecastAt?.(code, instant);
    if (!f) return "";
    const cat = flightCategory(f.ceil, f.vis);
    const ice = f.lice || f.hice ? ` · icing ${Math.max(f.lice, f.hice) === 2 ? "likely" : "possible"}` : "";
    return `<span class="trip-wx" style="--c:${CAT_COLORS[cat]}">${CAT_NAMES[cat]}${cat > 0 ? ` · ceiling ${esc(ceilingText(f.ceil))}` : ""}${f.thun ? " · thunderstorms" : ""}${ice}</span>`;
  };

  /**
   * The instrument-conditions drop-down for a leg: a red flag under the row when
   * either end is IFR or lower in the window, closed until opened; inside is the
   * ceiling timeline. "" when the leg stays out of instrument conditions (or
   * there is no forecast for it).
   */
  function timelineHtml(leg) {
    if (!forecastAt) return "";
    const dep = ceilingSeries(forecastAt, leg.from, leg.dep);
    const to = ceilingSeries(forecastAt, leg.to, leg.dep);
    if (!legIsInstrument(dep, to, leg.dep, leg.eta, 1)) return "";
    const rows = [dep && { code: leg.from, label: `${esc(leg.from)} (takeoff)`, series: dep }, to && { code: leg.to, label: `${esc(leg.to)} (landing)`, series: to }].filter(Boolean);
    // the tab names each affected field, its worst category and that moment's ceiling
    const worst = rows.map((r) => ({ r, w: worstSample(r.series, leg.dep, leg.eta) })).filter((x) => x.w);
    const top = Math.max(...worst.map((x) => x.w.cat));
    const which = worst.map(({ r, w }) => `${esc(r.code)} ${CAT_NAMES[w.cat]}, ceiling ${esc(ceilingText(w.f.ceil))}`).join(" · ");
    const lines = rows.map((r) => `<div><b>${esc(r.code)}</b> ${esc(summarize(r.series, leg.eta, leg.toTz))}</div>`).join("");
    return `<details class="trip-tl ${["", "tl-mvfr", "tl-ifr", "tl-lifr"][top]}" data-testid="ceiling-timeline" ${openTimelines.has(leg.i) ? "open" : ""}>
      <summary class="trip-tl-flag">⚠ ${which}</summary>
      <div class="trip-tl-body">
        <div class="trip-tl-head small muted">Ceiling from takeoff · times in ${esc(leg.to)} local (${esc(zoneAbbr(leg.eta, leg.toTz))})</div>
        ${timelineSvg({ rows, depAt: leg.dep, etaAt: leg.eta, tz: leg.toTz })}
        <div class="small trip-tl-sum">${lines}</div>
        <div class="muted small">Bar height is ceiling (full height = 5,000 ft or higher); colour is flight category. The forecast is 3-hourly and coarse near the ground — check the real weather before you go.</div>
      </div>
    </details>`;
  }

  /**
   * One leg as a table row: departure, arrival, takeoff, flight time, landing
   * time. Warnings, the ceiling timeline, the field name, forecast chips and
   * clock change sit under the row.
   */
  function legHtml(leg, state, info, { stop, count } = {}) {
    const gas = info.overRange ? `<div class="fp-flag warn">⚠ Tight on gas (${config.aircraft.legRangeNm}+ nm)</div>` : "";
    const alt = forecastAt ? alternateCheck(forecastAt, leg.to, leg.eta) : null;
    const altFlag = alt ? `<div class="fp-flag warn">⚠ Alternate may be required (${esc(alternateReason(alt))} at ${esc(leg.to)})</div>` : "";
    const flags = gas + altFlag + legFlags(leg).map((x) => `<div class="fp-flag ${x.level}">⚠ ${esc(x.text)}</div>`).join("");
    const takeoff = `${leg.depLocal.date}T${leg.depLocal.time}`;
    const shift = clockShift(leg.fromTz, leg.dep, leg.toTz, leg.eta);
    const from = leg.i === 0
      ? `<select class="trip-from" data-trip-base aria-label="Departure field, leg 1">${config.origins.map((o) => `<option value="${esc(o.id)}" ${o.id === state.originId ? "selected" : ""}>${esc(o.icao)}</option>`).join("")}</select>`
      : `<span class="trip-from trip-fixed">${esc(leg.from)}</span>`;
    const to = leg.isReturn
      ? `<span class="trip-to trip-fixed">${esc(leg.to)} <small class="muted">return</small></span>`
      : `<span class="trip-combo"><input class="trip-to" type="text" data-trip-arr data-i="${leg.i}" data-code="${esc(leg.to)}" value="${esc(leg.to)}" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="tripSuggest" aria-autocomplete="list" aria-label="Arrival field, leg ${leg.i + 1}"></span>${leg.ron ? `<small class="trip-ronmark">RON · ${leg.nights} night${leg.nights === 1 ? "" : "s"}</small>` : ""}`;
    const arriveDay = leg.etaLocal.date !== leg.depLocal.date ? ` ${esc(new Date(leg.eta).toLocaleDateString("en-US", { timeZone: leg.toTz, weekday: "short" }))}` : "";
    const ctl = leg.isReturn
      ? `<button type="button" data-trip="remove-return" aria-label="Remove the return leg">×</button>`
      : `<button type="button" data-trip="remove" data-i="${leg.i}" aria-label="Remove leg ${leg.i + 1} to ${esc(leg.to)}">×</button>`;
    const move = leg.isReturn ? "" : `<span class="trip-move"><button type="button" class="chip" data-trip="up" data-i="${leg.i}" aria-label="Move leg ${leg.i + 1} up" ${leg.i === 0 ? "disabled" : ""}>Move up</button> <button type="button" class="chip" data-trip="down" data-i="${leg.i}" aria-label="Move leg ${leg.i + 1} down" ${leg.i === count - 1 ? "disabled" : ""}>Move down</button></span>`;
    const chips = [wxChip(leg.from, leg.dep) && `<span class="muted">takeoff</span> ${wxChip(leg.from, leg.dep)}`, wxChip(leg.to, leg.eta) && `<span class="muted">landing</span> ${wxChip(leg.to, leg.eta)}`].filter(Boolean).join(" ");
    // under the row, always visible: the field's name (opens its sheet), the takeoff in Zulu (the row shows local time and the
    // landing), the clock change, the forecast chips and the reorder buttons. Nothing here repeats the row.
    const nameLine = [
      stop ? `<button type="button" class="cm-link" data-trip="select" data-code="${esc(stop.code)}">${esc(stop.field.name)}</button>${stop.field.fuel === "Not Approved" ? ` <span class="bad-text">no fuel</span>` : stop.field.fuel !== "Approved" ? ` <span class="warn-text">fuel: see comments</span>` : ""}` : "",
      `<span class="muted">${esc(zulu(leg.dep).time)} takeoff${leg.explicit || leg.i === 0 ? "" : " · follows the previous leg"}</span>${leg.explicit && leg.i > 0 ? ` <button type="button" class="cm-link" data-trip="reset-dep" data-i="${leg.i}">set takeoff back to automatic</button>` : ""}`,
    ].filter(Boolean).join(" · ");
    const details = [
      `<div class="trip-sub">${nameLine}</div>`,
      shift.text ? `<div class="fp-flag info">${esc(shift.text)}</div>` : "",
      chips || move ? `<div class="trip-wxrow">${chips}${move}</div>` : "",
    ].join("");
    return `<div class="trip-leg${leg.ron ? " trip-has-ron" : ""}" data-leg="${leg.i}">
      <div class="trip-row">
        <span class="trip-legno">${leg.i + 1}</span>
        <div class="trip-c trip-c-dep"><span class="trip-cl">Departure</span>${from}</div>
        <div class="trip-c trip-c-arr"><span class="trip-cl">Arrival</span>${to}</div>
        <div class="trip-c trip-c-take"><span class="trip-cl">Takeoff</span><span class="trip-take"><input type="datetime-local" step="300" data-trip-dep data-i="${leg.i}" value="${takeoff}" aria-label="Takeoff, leg ${leg.i + 1}, ${esc(leg.from)} local time"></span></div>
        <div class="trip-c trip-c-fly"><span class="trip-cl">Flight</span><b>${esc(formatFlightTime(info.mins))}</b><small class="muted">${Math.round(info.nm)} nm</small></div>
        <div class="trip-c trip-c-land"><span class="trip-cl">Lands</span><b>${esc(clock(leg.eta, leg.toTz))}</b><small class="muted">${esc(zoneAbbr(leg.eta, leg.toTz))}${arriveDay} · ${esc(zulu(leg.eta).time)}</small></div>
        <span class="trip-ctl">${ctl}</span>
      </div>
      ${flags}
      ${timelineHtml(leg)}
      <div class="trip-extra small">${details}</div>
    </div>`;
  }

  function render(state, origin) {
    const c = compute(state, origin);
    const { stops, legs, schedule, cost, route } = c;
    // the "add a leg" box says where the next leg starts
    const lastCode = stops.length ? stops.at(-1).code : origin.icao;
    if (addLabel) addLabel.textContent = `Add leg ${stops.length + 1}: ${lastCode} →`;
    // an arrival field being typed in must not be re-rendered out from under the user
    const editing = document.activeElement?.matches?.("[data-trip-arr]") && body.contains(document.activeElement) && document.activeElement.value !== document.activeElement.dataset.code;
    if (editing) return c;
    openTimelines = new Set([...body.querySelectorAll(".trip-tl[open]")].map((d) => Number(d.closest("[data-leg]").dataset.leg)));
    addBox.appendChild(suggest); // keep the list out of the markup about to be replaced
    current = null;
    if (!stops.length) {
      body.innerHTML = `<div class="rail-hint">Type the arrival field above to add your first leg from ${esc(origin.icao)}, or open any field on the map and tap <b>Add to trip</b>. Each leg is one row: departure, arrival, takeoff time, flight time and the landing time in the arrival field's local time. Instrument legs also get a ceiling timeline.</div>`;
      return c;
    }
    body.innerHTML = `
      <div class="trip-head" aria-hidden="true"><span></span><span>Departure</span><span>Arrival</span><span>Takeoff</span><span>Flight</span><span>Lands</span><span></span></div>
      <ol class="trip-list">
        ${stops.map((s, i) => `<li class="trip-stop">${legHtml(schedule[i], state, legs.legs[i], { stop: s, count: stops.length })}</li>`).join("")}
        ${state.tripReturn ? `<li class="trip-stop trip-ret">${legHtml(schedule.at(-1), state, legs.legs.at(-1), { count: stops.length })}</li>` : `<li class="trip-addret"><button type="button" class="chip" data-trip="add-return">+ Return leg to ${esc(origin.icao)}</button></li>`}
      </ol>
      <div class="trip-total"><b>${Math.round(legs.totalNm)} nm</b> · <b>${formatFlightTime(legs.totalMins)}</b> flying · ${legs.legs.length} leg${legs.legs.length === 1 ? "" : "s"}</div>
      <div class="trip-cost small">${cost.nights ? `${cost.nights} night${cost.nights === 1 ? "" : "s"} · lodging ${money(cost.lodging)} + M&amp;IE ${money(cost.meals)} = <b>${money(cost.total)}</b> <span class="muted">(GSA estimate${cost.missing.length ? `; no rate for ${esc(cost.missing.join(", "))}` : ""})</span>` : `<span class="muted">No overnights (every leg flies the same day it lands), so no per diem counted.</span>`}</div>
      <div class="trip-actions">
        <button type="button" class="chip chip-primary" data-trip="print">Print crew card</button>
        <button type="button" class="chip" data-trip="clear">Clear</button>
      </div>
      <div class="rail-hint">${esc(route)}</div>`;
    return c;
  }

  return { render, resolve, compute };
}
