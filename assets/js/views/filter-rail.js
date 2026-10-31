// The left rail: shared controls (departure base, range) plus the sections
// for whichever page is showing — fields/airspace on the planner, category
// and activity on the events page. Sections carry data-page="planner" |
// "events"; layout.css hides the ones that don't belong to the current page.
import { FIELD_FILTERS } from "../planner/fields.js";
import { AIRSPACE_LAYERS } from "../planner/airspace.js";

const CATEGORIES = ["concert", "festival", "rodeo", "fair", "sports", "art", "food", "outdoors", "holiday"];
const ACTIVITIES = [
  { key: "live-music", label: "Live Music" },
  { key: "art", label: "Art" },
  { key: "food", label: "Food" },
  { key: "nightlife", label: "Nightlife" },
  { key: "outdoors", label: "Outdoors" },
  { key: "weird", label: "Boutique" },
];

export function createFilterRail({ store, config }) {
  const $ = (id) => document.getElementById(id);
  const originChips = $("originChips");
  const rangeOriginLabel = $("rangeOriginLabel");
  const rangeSlider = $("rangeSlider");
  const rangeValue = $("rangeValue");
  const rangeCounts = $("rangeCounts");
  const rangeMarks = $("rangeMarks");
  const categoryChips = $("categoryChips");
  const activityChips = $("activityChips");
  const fieldSourceSwitch = $("fieldSourceSwitch");
  const fieldFilterChips = $("fieldFilterChips");
  const airspaceToggles = $("airspaceToggles");
  const railReset = $("railReset");
  const railToggleBtn = $("railToggle");
  const filterRail = $("filterRail");
  const railClose = $("railClose");
  const railBackdrop = $("railBackdrop");

  rangeSlider.min = config.rangeSlider.min;
  rangeSlider.max = config.rangeSlider.max;
  rangeSlider.step = config.rangeSlider.step;

  rangeMarks.innerHTML = config.rangeSlider.marks
    .map((nm) => {
      const pct = ((nm - config.rangeSlider.min) / (config.rangeSlider.max - config.rangeSlider.min)) * 100;
      const isLeg = nm === config.aircraft.legRangeNm;
      return `<span class="${isLeg ? "leg-boundary" : ""}" style="left:${pct}%">${nm}</span>`;
    })
    .join("");

  originChips.innerHTML = config.origins
    .map((o) => `<button class="chip" data-origin="${o.id}">${o.name} (${o.icao})</button>`)
    .join("");

  categoryChips.innerHTML =
    CATEGORIES.map((c) => `<button class="chip" data-cat="${c}">${c}</button>`).join("") +
    // "pr" isn't an event category but a tag (see scripts/lib/pr.js) — it
    // rides in this row because it filters the same way.
    `<button class="chip chip-pr" data-cat="pr" title="Possible PR opportunities: air shows (static display / flyover), military appreciation games, venues that have hosted flyovers, patriotic-holiday games">PR ops</button>`;
  activityChips.innerHTML = ACTIVITIES.map((a) => `<button class="chip" data-act="${a.key}">${a.label}</button>`).join("");

  fieldSourceSwitch.innerHTML = `
    <button type="button" data-src="nav">Nav Info List</button>
    <button type="button" data-src="p">P-coded fields</button>`;
  fieldFilterChips.innerHTML = FIELD_FILTERS.map((f) => `<button class="chip" data-ff="${f.key}">${f.label}</button>`).join("");
  airspaceToggles.innerHTML = AIRSPACE_LAYERS.map(
    (l) => `
      <div class="toggle-row" data-air="${l.key}">
        <div class="toggle-label"><span class="air-swatch" style="background:${l.style.color}"></span>${l.label}<span class="air-status" data-air-status="${l.key}"></span></div>
        <label class="switch"><input type="checkbox" data-air-toggle="${l.key}" aria-label="${l.label}"><span class="slider"></span></label>
      </div>`
  ).join("");

  originChips.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-origin]");
    if (!btn) return;
    const originId = btn.dataset.origin;
    const patch = { originId };
    // The nav info list is Vance's: its approvals and distances are Vance's.
    // From any other base the useful list is the P-coded fields (usable
    // without being on an approval list); switch automatically, and the
    // user can still flip back.
    patch.fieldSource = originId === config.defaultOriginId ? "nav" : "p";
    store.setState(patch);
  });

  rangeSlider.addEventListener("input", () => store.setState({ rangeNm: Number(rangeSlider.value) }));

  categoryChips.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cat]");
    if (!btn) return;
    const cats = new Set(store.getState().categories);
    cats.has(btn.dataset.cat) ? cats.delete(btn.dataset.cat) : cats.add(btn.dataset.cat);
    store.setState({ categories: cats });
  });

  activityChips.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const acts = new Set(store.getState().activities);
    acts.has(btn.dataset.act) ? acts.delete(btn.dataset.act) : acts.add(btn.dataset.act);
    store.setState({ activities: acts });
  });

  fieldSourceSwitch.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-src]");
    if (btn) store.setState({ fieldSource: btn.dataset.src });
  });

  fieldFilterChips.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ff]");
    if (!btn) return;
    const ff = new Set(store.getState().fieldFilters);
    ff.has(btn.dataset.ff) ? ff.delete(btn.dataset.ff) : ff.add(btn.dataset.ff);
    store.setState({ fieldFilters: ff });
  });

  airspaceToggles.addEventListener("change", (e) => {
    const input = e.target.closest("[data-air-toggle]");
    if (!input) return;
    const air = new Set(store.getState().airspace);
    input.checked ? air.add(input.dataset.airToggle) : air.delete(input.dataset.airToggle);
    store.setState({ airspace: air });
  });

  railReset.addEventListener("click", () => store.reset());

  // On mobile the rail opens as a fixed sheet over the page. The header's
  // toggle button scrolls out of reach with the rest of the page, so the
  // sheet has its own close button, a tap-anywhere backdrop, and Escape.
  function setRailOpen(open) {
    filterRail.classList.toggle("open", open);
    railBackdrop.classList.toggle("open", open);
    railToggleBtn.setAttribute("aria-expanded", String(open));
  }
  railToggleBtn.addEventListener("click", () => setRailOpen(!filterRail.classList.contains("open")));
  railClose.addEventListener("click", () => setRailOpen(false));
  railBackdrop.addEventListener("click", () => setRailOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && filterRail.classList.contains("open")) setRailOpen(false);
  });

  function syncFromState(state) {
    originChips.querySelectorAll("[data-origin]").forEach((btn) => btn.classList.toggle("active", btn.dataset.origin === state.originId));
    const origin = config.origins.find((o) => o.id === state.originId) || config.origins[0];
    rangeOriginLabel.textContent = origin.icao;
    rangeSlider.value = state.rangeNm;
    rangeValue.textContent = state.rangeNm;
    categoryChips.querySelectorAll("[data-cat]").forEach((btn) => btn.classList.toggle("active", state.categories.has(btn.dataset.cat)));
    activityChips.querySelectorAll("[data-act]").forEach((btn) => btn.classList.toggle("active", state.activities.has(btn.dataset.act)));
    fieldSourceSwitch.querySelectorAll("[data-src]").forEach((btn) => btn.classList.toggle("active", btn.dataset.src === state.fieldSource));
    fieldFilterChips.querySelectorAll("[data-ff]").forEach((btn) => btn.classList.toggle("active", state.fieldFilters.has(btn.dataset.ff)));
    airspaceToggles.querySelectorAll("[data-air-toggle]").forEach((i) => (i.checked = state.airspace.has(i.dataset.airToggle)));
    document.querySelector(".app").dataset.page = state.view;
  }

  function setCounts(text) {
    rangeCounts.textContent = text;
  }

  /** "loading…" / "error" note next to an airspace toggle. */
  function setAirspaceStatus(key, text) {
    const el = airspaceToggles.querySelector(`[data-air-status="${key}"]`);
    if (el) el.textContent = text ? ` · ${text}` : "";
  }

  return { syncFromState, setCounts, setAirspaceStatus, ACTIVITIES };
}
