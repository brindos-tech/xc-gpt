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
  const originChips = document.getElementById("originChips");
  const rangeOriginLabel = document.getElementById("rangeOriginLabel");
  const rangeSlider = document.getElementById("rangeSlider");
  const rangeValue = document.getElementById("rangeValue");
  const rangeCounts = document.getElementById("rangeCounts");
  const rangeMarks = document.getElementById("rangeMarks");
  const westToggle = document.getElementById("westToggle");
  const westDelta = document.getElementById("westDelta");
  const categoryChips = document.getElementById("categoryChips");
  const activityChips = document.getElementById("activityChips");
  const railReset = document.getElementById("railReset");
  const railToggleBtn = document.getElementById("railToggle");
  const filterRail = document.getElementById("filterRail");
  const railClose = document.getElementById("railClose");
  const railBackdrop = document.getElementById("railBackdrop");

  rangeSlider.min = config.rangeSlider.min;
  rangeSlider.max = config.rangeSlider.max;
  rangeSlider.step = config.rangeSlider.step;

  const marksHtml = config.rangeSlider.marks
    .map((nm) => {
      const pct = ((nm - config.rangeSlider.min) / (config.rangeSlider.max - config.rangeSlider.min)) * 100;
      const isLeg = nm === config.aircraft.legRangeNm;
      return `<span class="${isLeg ? "leg-boundary" : ""}" style="left:${pct}%">${nm}</span>`;
    })
    .join("");
  rangeMarks.innerHTML = marksHtml;

  originChips.innerHTML = config.origins
    .map((o) => `<button class="chip" data-origin="${o.id}">${o.name} (${o.icao})</button>`)
    .join("");

  // "pr" isn't an event category but a tag (see scripts/lib/pr.js) — it
  // rides in this row because it filters the same way: show events that
  // have it. Its chip explains itself on hover.
  categoryChips.innerHTML =
    CATEGORIES.map((c) => `<button class="chip" data-cat="${c}">${c}</button>`).join("") +
    `<button class="chip chip-pr" data-cat="pr" title="Possible PR opportunities: air shows (static display / flyover), military appreciation games, venues that have hosted flyovers, patriotic-holiday games">PR ops</button>`;
  activityChips.innerHTML = ACTIVITIES.map(
    (a) => `<button class="chip" data-act="${a.key}">${a.label}</button>`
  ).join("");

  originChips.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-origin]");
    if (!btn) return;
    store.setState({ originId: btn.dataset.origin });
  });

  rangeSlider.addEventListener("input", () => {
    store.setState({ rangeNm: Number(rangeSlider.value) });
  });

  westToggle.addEventListener("change", () => {
    store.setState({ westOnly: westToggle.checked });
  });

  categoryChips.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cat]");
    if (!btn) return;
    const cat = btn.dataset.cat;
    const cats = new Set(store.getState().categories);
    cats.has(cat) ? cats.delete(cat) : cats.add(cat);
    store.setState({ categories: cats });
  });

  activityChips.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const acts = new Set(store.getState().activities);
    acts.has(act) ? acts.delete(act) : acts.add(act);
    store.setState({ activities: acts });
  });

  railReset.addEventListener("click", () => store.reset());

  // On mobile the rail opens as a fixed sheet over the page. The header's
  // toggle button is the only thing that closes it, and the header sits in
  // normal flow — scroll down and it leaves the viewport while the fixed
  // sheet stays, stranding the user with no way out. Give the sheet its own
  // close button, a tap-anywhere backdrop, and Escape.
  function setRailOpen(open) {
    filterRail.classList.toggle("open", open);
    railBackdrop.classList.toggle("open", open);
    railToggleBtn.setAttribute("aria-expanded", String(open));
  }

  railToggleBtn.addEventListener("click", () => {
    setRailOpen(!filterRail.classList.contains("open"));
  });
  railClose.addEventListener("click", () => setRailOpen(false));
  railBackdrop.addEventListener("click", () => setRailOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && filterRail.classList.contains("open")) setRailOpen(false);
  });

  function syncFromState(state) {
    originChips.querySelectorAll("[data-origin]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.origin === state.originId);
    });
    const origin = config.origins.find((o) => o.id === state.originId) || config.origins[0];
    rangeOriginLabel.textContent = origin.icao;
    rangeSlider.value = state.rangeNm;
    rangeValue.textContent = state.rangeNm;
    westToggle.checked = state.westOnly;
    categoryChips.querySelectorAll("[data-cat]").forEach((btn) => {
      btn.classList.toggle("active", state.categories.has(btn.dataset.cat));
    });
    activityChips.querySelectorAll("[data-act]").forEach((btn) => {
      btn.classList.toggle("active", state.activities.has(btn.dataset.act));
    });
  }

  function setCounts(placeCount, eventCount) {
    rangeCounts.textContent = `${placeCount} place${placeCount === 1 ? "" : "s"} · ${eventCount} event${eventCount === 1 ? "" : "s"} in window`;
  }

  function setWestDelta(text) {
    westDelta.textContent = text || "";
  }

  return { syncFromState, setCounts, setWestDelta, ACTIVITIES };
}
