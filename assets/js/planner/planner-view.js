// The planner map: nav-info fields as pins, the range ring from the
// selected base, and toggleable airspace layers (MOA, restricted, warning,
// alert, IR / VR / SR routes). Airspace data is large (≈2.5 MB together), so
// each file loads the first time a layer from it is switched on.
import { fieldStatus, STATUS_LABELS } from "./fields.js";
import { AIRSPACE_LAYERS, airspaceTooltip } from "./airspace.js";
import { esc } from "./html.js";

export const STATUS_COLORS = { go: "#3ddc97", check: "#e8c15e", nofuel: "#ff8a3d", no: "#e65a5a" };

export function createPlannerView({ config, origin, loadJson, onFieldClick, onAirspaceClick, onAirspaceStatus }) {
  const map = L.map("plannerMap", { zoomControl: true }).setView([origin.lat, origin.lon], 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap", maxZoom: 12 }).addTo(map);

  // Airspace polygons/lines go on a canvas renderer in a lower pane (hundreds
  // of vector shapes are too heavy as SVG); field pins stay SVG on top so
  // each pin is a real DOM node that can take keyboard focus.
  map.createPane("airspace").style.zIndex = 350;
  const airspaceRenderer = L.canvas({ pane: "airspace", padding: 0.3 });
  const pinRenderer = L.svg();

  const originMarker = L.circleMarker([origin.lat, origin.lon], { radius: 6, color: "#fff", fillColor: "#fff", fillOpacity: 1, weight: 2, renderer: pinRenderer })
    .bindTooltip(`${origin.name} (${origin.icao})`, { className: "map-tooltip" })
    .addTo(map);
  const rangeCircle = L.circle([origin.lat, origin.lon], {
    radius: config.defaults.rangeNm * 1852,
    color: "#ff8a3d", weight: 1.5, dashArray: "6,6", fill: false, opacity: 0.6, interactive: false, renderer: pinRenderer,
  }).addTo(map);
  const pinLayer = L.layerGroup().addTo(map);

  // ---- airspace ----
  const files = { sua: { url: "generated/airspace-sua.json", data: null, promise: null }, mtr: { url: "generated/airspace-mtr.json", data: null, promise: null } };
  const groups = new Map(); // layer key -> L.layerGroup
  const featuresById = new Map();
  let wanted = new Set();
  let selectedAirspaceId = null;

  function loadFile(kind) {
    const f = files[kind];
    f.promise ??= loadJson(f.url).then((d) => {
      f.data = d;
      for (const feat of d.features) featuresById.set(feat.properties.id, feat.properties);
      return d;
    });
    return f.promise;
  }

  function styleFor(layer, props) {
    const base = layer.style;
    return props.id === selectedAirspaceId ? { ...base, weight: (base.weight || 1) + 2, opacity: 1, fillOpacity: Math.min(0.35, (base.fillOpacity ?? 0) * 3) } : base;
  }

  async function ensureLayer(layer) {
    if (groups.has(layer.key)) return;
    onAirspaceStatus(layer.key, "loading…");
    try {
      const data = await loadFile(layer.file);
      if (groups.has(layer.key)) return;
      const subset = { type: "FeatureCollection", features: data.features.filter((f) => layer.match(f.properties)) };
      const group = L.geoJSON(subset, {
        renderer: airspaceRenderer,
        style: (f) => styleFor(layer, f.properties),
        onEachFeature: (f, lyr) => {
          lyr.bindTooltip(airspaceTooltip(f.properties), { className: "map-tooltip", sticky: true });
          lyr.on("click", (e) => {
            L.DomEvent.stopPropagation(e);
            onAirspaceClick(f.properties.id);
          });
        },
      });
      groups.set(layer.key, group);
      onAirspaceStatus(layer.key, `${subset.features.length}`);
      applyWanted();
    } catch (err) {
      console.warn(`Airspace ${layer.key} failed to load:`, err);
      onAirspaceStatus(layer.key, "unavailable");
    }
  }

  function applyWanted() {
    for (const layer of AIRSPACE_LAYERS) {
      const group = groups.get(layer.key);
      if (!group) continue;
      if (wanted.has(layer.key)) group.addTo(map);
      else map.removeLayer(group);
    }
  }

  /** Switch layers on/off to match `keys`; loads data on first use. */
  function setAirspace(keys, selectedId) {
    wanted = keys;
    for (const layer of AIRSPACE_LAYERS) if (wanted.has(layer.key)) ensureLayer(layer);
    applyWanted();
    if (selectedId !== selectedAirspaceId) {
      selectedAirspaceId = selectedId;
      for (const layer of AIRSPACE_LAYERS) groups.get(layer.key)?.eachLayer((l) => l.setStyle(styleFor(layer, l.feature.properties)));
    }
  }

  // ---- fields ----
  function renderFields({ fields }, selectedFieldId) {
    pinLayer.clearLayers();
    for (const f of fields) {
      const status = fieldStatus(f);
      const color = STATUS_COLORS[status];
      const selected = f.id === selectedFieldId;
      const marker = L.circleMarker([f.lat, f.lon], {
        radius: selected ? 9 : 6,
        color: selected ? "#fff" : color,
        fillColor: color,
        fillOpacity: f.outOfRange ? 0.25 : 0.8,
        weight: selected ? 2.5 : 1.5,
        opacity: f.outOfRange ? 0.5 : 1,
        dashArray: f.outOfRange ? "2,3" : null,
        renderer: pinRenderer,
      });
      marker.bindTooltip(
        `<b>${esc(f.code)}</b> — ${esc(f.name)}<br>${esc(f.city)} · ${Math.round(f.distanceNm)} nm${f.fbo ? `<br>${esc(f.fbo)}` : ""}<br><span style="color:var(--muted)">${STATUS_LABELS[status]}</span>`,
        { className: "map-tooltip", direction: "top", offset: [0, -6] }
      );
      marker.on("click", () => onFieldClick(f.id));
      marker.addTo(pinLayer);

      const el = marker.getElement();
      if (el) {
        el.setAttribute("tabindex", "0");
        el.setAttribute("role", "button");
        el.setAttribute("data-field", f.id);
        el.setAttribute("aria-label", `${f.code} ${f.name}, ${f.city}, ${STATUS_LABELS[status]}`);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onFieldClick(f.id);
          }
        });
      }
    }
  }

  function setOrigin(o) {
    originMarker.setLatLng([o.lat, o.lon]);
    originMarker.setTooltipContent(`${o.name} (${o.icao})`);
    rangeCircle.setLatLng([o.lat, o.lon]);
    map.flyTo([o.lat, o.lon], map.getZoom(), { duration: 0.6 });
  }

  return {
    renderFields,
    setAirspace,
    setOrigin,
    updateRange: (nm) => rangeCircle.setRadius(nm * 1852),
    getAirspace: (id) => featuresById.get(id) || null,
    // an airspace id from a shared link needs its file loaded before it can be shown
    ensureAirspaceData: (id) => (id?.startsWith("MOA:") || /^[RWA]:/.test(id || "") ? loadFile("sua") : id ? loadFile("mtr") : Promise.resolve()),
    invalidateSize: () => map.invalidateSize(),
    flyTo: (lat, lon) => map.flyTo([lat, lon], Math.max(map.getZoom(), 8), { duration: 0.6 }),
    legendStatuses: Object.entries(STATUS_LABELS).map(([k, label]) => ({ key: k, label, color: STATUS_COLORS[k] })),
  };
}
