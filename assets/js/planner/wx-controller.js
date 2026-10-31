// The planner's weather layer: a day picker (today … +7), a local-time slider,
// overlay toggles, the map images, per-field forecast, and a click-for-point
// forecast. Everything comes from the model grid in data/generated/wx/ — a
// planning aid, not a weather brief.
import { toDateKey, addDays, formatUpdatedAgo, parseDate } from "../format.js";
import { createWxData } from "./wx-data.js";
import { renderStyle, gridBounds, WX_STYLES } from "./wx-raster.js";
import { CAT_COLORS, CAT_NAMES, ICE_LABELS, THUN_LABELS, NO_CEILING, flightCategory, ceilingText, visText, precipText } from "./wx-model.js";
import { esc } from "./html.js";

export const WX_LAYERS = [
  { key: "radar", label: "Radar", title: "Live NEXRAD radar at “now”; model precipitation for any other time" },
  { key: "cat", label: "Flight category", title: "Forecast VFR / MVFR / IFR / LIFR (only MVFR and worse are tinted)" },
  { key: "lice", label: "Icing · low", title: "Possible / likely icing below 10,000 ft MSL" },
  { key: "hice", label: "Icing · high", title: "Possible / likely icing 10,000–25,000 ft MSL" },
  { key: "ceil", label: "Ceiling", title: "Forecast ceiling below 3,000 ft AGL" },
  { key: "thun", label: "Thunderstorms", title: "Possible / likely thunderstorms" },
];
export const DEFAULT_WX = ["radar"];

const RADAR_URL = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png?t={t}";
const NOW_WINDOW_MS = 90 * 60 * 1000;

const LEGENDS = {
  radar_live: { text: "Radar (live NEXRAD)", swatch: ["#3cbe5a", "#ebd246", "#ff8a3d", "#e64646"] },
  radar_fc: { text: "Forecast precip (model)", swatch: ["#78dc96", "#3cbe5a", "#ebd246", "#ff8a3d", "#e64646"] },
  cat: { text: "MVFR / IFR / LIFR", swatch: CAT_COLORS.slice(1) },
  lice: { text: "Low icing (<10k ft)", swatch: ["#3cc8ff"] },
  hice: { text: "High icing (10–25k ft)", swatch: ["#b078ff"] },
  ceil: { text: "Ceiling <500 / <1k / <2k / ≤3k ft", swatch: ["#d65be0", "#e65a5a", "#ff8a3d", "#e8c15e"] },
  thun: { text: "Thunderstorms", swatch: ["#ff3c3c"] },
};

const localTime = (iso, withZone = false) => new Date(iso).toLocaleTimeString([], withZone ? { hour: "numeric", timeZoneName: "short" } : { hour: "numeric" });

export function createWxController({ store, map, loadJson, today, onChange }) {
  const wxData = createWxData(loadJson);
  const bar = document.getElementById("wxBar");
  let ready = false;
  let loading = false;
  let collapsed = true; // starts as a small header; the arrow opens the controls
  let overlays = new Map(); // style key -> L.ImageOverlay
  let drawnKey = "";
  let radarLayer = null;
  let lastRenderKey = "";
  let popup = null;

  // ---- time selection ----
  function stepsFor(dateKey) {
    return wxData.stepsForLocalDate(dateKey);
  }

  /** The step to show: the user's pick if it belongs to the day, else a sensible default. */
  function currentStep(state) {
    const steps = stepsFor(state.tripDate);
    if (!steps.length) return null;
    if (state.wxTime && steps.includes(state.wxTime)) return state.wxTime;
    const target = state.tripDate === toDateKey(today) ? Date.now() : parseDate(state.tripDate).getTime() + 10 * 3600 * 1000;
    return steps.reduce((best, s) => (Math.abs(new Date(s) - target) < Math.abs(new Date(best) - target) ? s : best));
  }

  const isNow = (state, step) => state.tripDate === toDateKey(today) && step && Math.abs(new Date(step) - Date.now()) <= NOW_WINDOW_MS;

  // ---- bar ----
  function buildBar() {
    const days = Array.from({ length: 8 }, (_, i) => addDays(today, i));
    bar.innerHTML = `
      <div class="wx-head">
        <b>Weather</b>
        <span class="wx-summary" id="wxSummary"></span>
        <button class="wx-collapse" id="wxCollapse" aria-expanded="${!collapsed}" aria-controls="wxBody" aria-label="Show or hide weather controls">${collapsed ? "▴" : "▾"}</button>
      </div>
      <div class="wx-body" id="wxBody" ${collapsed ? "hidden" : ""}>
        <div class="wx-days" role="group" aria-label="Day of travel">${days
          .map((d, i) => `<button class="chip" data-wx-day="${toDateKey(d)}">${i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" })}</button>`)
          .join("")}</div>
        <div class="wx-time">
          <button class="chip" id="wxNow">Now</button>
          <input type="range" id="wxSlider" min="0" max="0" step="1" value="0" aria-label="Time of day, local">
          <output id="wxTimeLabel" for="wxSlider"></output>
        </div>
        <div class="wx-layers chip-row" role="group" aria-label="Weather overlays">${WX_LAYERS.map((l) => `<button class="chip" data-wx-layer="${l.key}" title="${esc(l.title)}">${l.label}</button>`).join("")}</div>
        <div class="wx-legend" id="wxLegend"></div>
      </div>
      <div class="wx-disclaimer" id="wxDisclaimer">Model-derived planning aid — <b>not a weather brief</b>. Icing and ceiling are estimated from a ~60 nm forecast grid with coarse vertical levels. Get a standard briefing before you fly.</div>`;
    bar.hidden = false;

    bar.addEventListener("click", (e) => {
      const day = e.target.closest("[data-wx-day]");
      if (day && !day.disabled) return store.setState({ tripDate: day.dataset.wxDay, wxTime: null });
      const layer = e.target.closest("[data-wx-layer]");
      if (layer) {
        const next = new Set(store.getState().wxLayers);
        next.has(layer.dataset.wxLayer) ? next.delete(layer.dataset.wxLayer) : next.add(layer.dataset.wxLayer);
        return store.setState({ wxLayers: next });
      }
      if (e.target.closest("#wxNow")) return store.setState({ tripDate: toDateKey(today), wxTime: nearestToNow() });
      if (e.target.closest("#wxCollapse")) {
        collapsed = !collapsed;
        bar.querySelector("#wxBody").hidden = collapsed;
        const btn = bar.querySelector("#wxCollapse");
        btn.textContent = collapsed ? "▴" : "▾";
        btn.setAttribute("aria-expanded", String(!collapsed));
        requestAnimationFrame(() => map.invalidateSize());
      }
    });
    bar.querySelector("#wxSlider").addEventListener("input", (e) => {
      const steps = stepsFor(store.getState().tripDate);
      const s = steps[Number(e.target.value)];
      if (s) store.setState({ wxTime: s });
    });
  }

  function nearestToNow() {
    const steps = stepsFor(toDateKey(today));
    if (!steps.length) return null;
    return steps.reduce((b, s) => (Math.abs(new Date(s) - Date.now()) < Math.abs(new Date(b) - Date.now()) ? s : b));
  }

  function syncBar(state, step) {
    const steps = stepsFor(state.tripDate);
    bar.querySelectorAll("[data-wx-day]").forEach((b) => {
      b.classList.toggle("active", b.dataset.wxDay === state.tripDate);
      b.disabled = !stepsFor(b.dataset.wxDay).length;
    });
    bar.querySelectorAll("[data-wx-layer]").forEach((b) => b.classList.toggle("active", state.wxLayers.has(b.dataset.wxLayer)));
    const slider = bar.querySelector("#wxSlider");
    slider.max = String(Math.max(0, steps.length - 1));
    slider.disabled = steps.length < 2;
    const idx = Math.max(0, steps.indexOf(step));
    if (Number(slider.value) !== idx) slider.value = String(idx);
    bar.querySelector("#wxTimeLabel").textContent = step ? localTime(step, true) : "no data";
    bar.querySelector("#wxNow").classList.toggle("active", isNow(state, step));
    const when = step ? new Date(step).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "";
    bar.querySelector("#wxSummary").textContent = step ? `${when} · ${localTime(step)}` : "no forecast for this day";

    // legend: only what's switched on
    const legend = [];
    for (const key of state.wxLayers) {
      const l = key === "radar" ? (isNow(state, step) ? LEGENDS.radar_live : LEGENDS.radar_fc) : LEGENDS[key];
      if (l) legend.push(`<span>${l.swatch.map((c) => `<i class="wx-sw" style="background:${c}"></i>`).join("")}${l.text}</span>`);
    }
    bar.querySelector("#wxLegend").innerHTML = legend.join("") || `<span class="muted">No overlays selected.</span>`;
    const gen = wxData.index?.generatedAt;
    bar.querySelector("#wxDisclaimer").title = gen ? `Forecast built ${formatUpdatedAgo(gen)}` : "";
  }

  // ---- map images ----
  function clearOverlays() {
    for (const o of overlays.values()) map.removeLayer(o);
    overlays.clear();
    if (radarLayer) {
      map.removeLayer(radarLayer);
      radarLayer = null;
    }
    drawnKey = "";
  }

  async function drawMap(state, step) {
    const live = isNow(state, step);
    const key = `${step}|${[...state.wxLayers].sort().join(",")}|${live}`;
    if (key === drawnKey) return;
    drawnKey = key;
    if (!step) return clearOverlays();
    await wxData.ensureSteps([step]).catch(() => {});
    if (drawnKey !== key) return; // superseded while loading

    const idx = wxData.index;
    const cov = Uint8Array.from(idx.grid.cov, Number);
    const want = new Set();
    for (const k of state.wxLayers) want.add(k === "radar" ? (live ? null : "prec") : k);
    want.delete(null);

    for (const [k, o] of [...overlays]) {
      if (!want.has(k)) {
        map.removeLayer(o);
        overlays.delete(k);
      }
    }
    for (const k of want) {
      const style = WX_STYLES[k];
      const layers = {};
      let missing = false;
      for (const n of style.needs) {
        layers[n] = wxData.layerValues(step, n);
        if (!layers[n]) missing = true;
      }
      if (missing) continue;
      const url = renderStyle(idx.grid, cov, style, layers);
      const existing = overlays.get(k);
      if (existing) existing.setUrl(url);
      else {
        const o = L.imageOverlay(url, gridBounds(idx.grid), { pane: "wx", interactive: false, opacity: 1 });
        o.addTo(map);
        overlays.set(k, o);
      }
    }

    const wantRadar = state.wxLayers.has("radar") && live;
    if (wantRadar && !radarLayer) {
      radarLayer = L.tileLayer(RADAR_URL, { pane: "wx", opacity: 0.7, maxNativeZoom: 10, maxZoom: 12, t: Math.floor(Date.now() / 300000), attribution: 'NEXRAD: <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a>' });
      radarLayer.addTo(map);
    } else if (!wantRadar && radarLayer) {
      map.removeLayer(radarLayer);
      radarLayer = null;
    }
  }

  // ---- fields ----
  const fieldNow = (code) => {
    const state = store.getState();
    const step = currentStep(state);
    return step && wxData.hasFields ? wxData.fieldAt(code, step) : null;
  };

  /** Ring colour for a field pin: MVFR or worse (and thunder). null = nothing to flag. */
  function fieldRing(code) {
    if (!ready || store.getState().wxLayers.size === 0) return null;
    const f = fieldNow(code);
    if (!f) return null;
    const cat = flightCategory(f.ceil, f.vis);
    return cat > 0 ? CAT_COLORS[cat] : null;
  }

  /** Rows for the field sheet: the whole local day, 3-hourly. */
  function fieldRows(code, dateKey) {
    if (!ready || !wxData.hasFields) return null;
    const rows = stepsFor(dateKey)
      .map((step) => {
        const f = wxData.fieldAt(code, step);
        return f && { step, time: localTime(step), ...f, cat: flightCategory(f.ceil, f.vis) };
      })
      .filter(Boolean);
    return rows.length ? rows : null;
  }

  // ---- point forecast ----
  function pointHtml(p, step) {
    const cat = flightCategory(p.ceil, p.vis);
    return `<b>${new Date(step).toLocaleString([], { weekday: "short", hour: "numeric", timeZoneName: "short" })}</b><br>
      <span style="color:${CAT_COLORS[cat]}">${CAT_NAMES[cat]}</span> · ceiling ${ceilingText(p.ceil)} · vis ${visText(p.vis)}<br>
      Icing low: ${ICE_LABELS[p.lice]} · high: ${ICE_LABELS[p.hice]}<br>
      Precip: ${precipText(p.prec)} · thunder: ${THUN_LABELS[p.thun]}<br>
      <span class="muted">Model grid estimate, not a briefing</span>`;
  }

  map.on("click", (e) => {
    if (!ready) return;
    const state = store.getState();
    const step = currentStep(state);
    if (!step || !state.wxLayers.size) return;
    const p = wxData.pointAt(step, e.latlng.lat, e.latlng.lng);
    if (!p) return;
    popup = L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(pointHtml(p, step)).openOn(map);
  });

  // ---- lifecycle ----
  async function load() {
    if (loading || ready) return;
    loading = true;
    const ok = await wxData.init();
    if (ok) {
      buildBar();
      // fields file is only needed for pin rings and the field sheet
      wxData.loadFields().then(() => onChange());
      ready = true;
      const first = stepsFor(store.getState().tripDate)[0];
      if (first) await wxData.ensureSteps([first]).catch(() => {});
    }
    loading = false;
    onChange();
  }

  /** Called on every planner render. */
  function render(state) {
    if (!ready) {
      load();
      return;
    }
    const step = currentStep(state);
    const key = `${state.tripDate}|${step}|${[...state.wxLayers].sort().join(",")}`;
    syncBar(state, step);
    if (key !== lastRenderKey) {
      lastRenderKey = key;
      drawMap(state, step);
    }
  }

  function hide() {
    if (popup) map.closePopup(popup);
  }

  return { render, hide, fieldRing, fieldRows, get ready() { return ready; } };
}
