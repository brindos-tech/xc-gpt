// The planner map: nav-info fields as pins, the range ring from the
// selected base, and toggleable airspace layers (MOA, restricted, warning,
// alert, IR / VR / SR routes). Airspace data is large (≈2.5 MB together), so
// each file loads the first time a layer from it is switched on.
import { fieldStatus, STATUS_LABELS, isTowered, isMilitary } from "./fields.js";
import { AIRSPACE_LAYERS, airspaceTooltip } from "./airspace.js";
import { esc } from "./html.js";
import { distanceToGeometryNm } from "../geo.js";

export const STATUS_COLORS = { go: "#3ddc97", check: "#e8c15e", nofuel: "#ff8a3d", no: "#e65a5a" };

// Chart-style field marks: blue = towered, magenta = non-towered, a star in the
// ring = military. The small corner dot keeps the crew-approval status.
const TOWERED = "#1d63d6";
const NON_TOWERED = "#c4188f";
const STAR = "12,5.2 13.9,10 19,10.2 15,13.3 16.4,18.2 12,15.4 7.6,18.2 9,13.3 5,10.2 10.1,10";

export function pinSvg({ towered, military, status }) {
  const c = towered ? TOWERED : NON_TOWERED;
  return `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
    <circle cx="12" cy="12" r="9.4" fill="#fff" fill-opacity="0.92"/>
    <circle cx="12" cy="12" r="8" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-width="2.6"/>
    ${military ? `<polygon points="${STAR}" fill="${c}"/>` : `<circle cx="12" cy="12" r="2.4" fill="${c}"/>`}
    <circle cx="19.2" cy="19.2" r="4.1" fill="${STATUS_COLORS[status]}" stroke="#fff" stroke-width="1.4"/>
  </svg>`;
}

/** Legend HTML for the planner map. */
export function legendHtml() {
  const mini = (towered, military) => `<span class="legend-pin">${pinSvg({ towered, military, status: "go" }).replace('width="26" height="26"', 'width="18" height="18"')}</span>`;
  return (
    `<span>${mini(true, false)}Towered</span><span>${mini(false, false)}Non-towered</span><span>${mini(true, true)}Military</span>` +
    Object.entries(STATUS_LABELS)
      .map(([k, label]) => `<span><span class="legend-dot" style="background:${STATUS_COLORS[k]}"></span>${label}</span>`)
      .join("") +
    `<span class="legend-note">faded = outside range (search result)</span>`
  );
}

export function createPlannerView({ config, origin, loadJson, onFieldClick, onAirspaceClick, onAirspaceStatus }) {
  // A phone's narrower map needs one zoom level less to show the whole ring.
  const map = L.map("plannerMap", { zoomControl: true }).setView([origin.lat, origin.lon], window.innerWidth < 600 ? 4 : 5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap", maxZoom: 12 }).addTo(map);

  // Airspace polygons/lines go on a canvas renderer in a lower pane (hundreds
  // of vector shapes are too heavy as SVG); field pins stay SVG on top so
  // each pin is a real DOM node that can take keyboard focus.
  map.createPane("wx").style.zIndex = 320; // forecast images sit under the airspace
  map.createPane("airspace").style.zIndex = 350;
  const airspaceRenderer = L.canvas({ pane: "airspace", padding: 0.3 });
  const pinRenderer = L.svg();

  const originMarker = L.circleMarker([origin.lat, origin.lon], { radius: 6, color: "#fff", fillColor: "#fff", fillOpacity: 1, weight: 2, renderer: pinRenderer })
    .bindTooltip(`${origin.name} (${origin.icao})`, { className: "map-tooltip" })
    .addTo(map);
  let originPos = { lat: origin.lat, lon: origin.lon };
  let rangeNm = config.defaults.rangeNm;
  const rangeCircle = L.circle([origin.lat, origin.lon], {
    radius: rangeNm * 1852,
    color: "#ff8a3d", weight: 1.5, dashArray: "6,6", fill: false, opacity: 0.6, interactive: false, renderer: pinRenderer,
  }).addTo(map);
  const pinLayer = L.layerGroup().addTo(map);
  const tripLine = L.polyline([], { color: "#ff8a3d", weight: 3, opacity: 0.9, dashArray: "2,7", interactive: false, renderer: pinRenderer }).addTo(map);

  // ---- airspace ----
  const files = {
    sua: { url: "generated/airspace-sua.json", data: null, promise: null },
    mtr: { url: "generated/airspace-mtr.json", data: null, promise: null },
    // TFRs change hourly: read them straight from the wx-data branch (CORS-open raw URL), else the copy shipped with the site
    tfr: { url: "generated/wx/tfr.json", remote: config.tfrUrl, data: null, promise: null },
  };
  const groups = new Map(); // layer key -> { group: L.layerGroup, entries: [{ lyr, geom, props, dist }], count }
  const featuresById = new Map();
  let wanted = new Set();
  let selectedAirspaceId = null;

  function loadFile(kind) {
    const f = files[kind];
    f.promise ??= (f.remote
      ? fetch(f.remote, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).catch(() => loadJson(f.url))
      : loadJson(f.url)
    ).then((d) => {
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
      const entries = data.features
        .filter((f) => layer.match(f.properties))
        .map((f) => ({
          geom: f.geometry,
          props: f.properties,
          dist: distanceToGeometryNm(f.geometry, originPos),
          lyr: L.geoJSON(f, {
            renderer: airspaceRenderer,
            style: () => styleFor(layer, f.properties),
            onEachFeature: (feat, lyr) => {
              lyr.bindTooltip(airspaceTooltip(feat.properties), { className: "map-tooltip", sticky: true });
              lyr.on("click", (e) => {
                L.DomEvent.stopPropagation(e);
                onAirspaceClick(feat.properties.id);
              });
            },
          }),
        }));
      groups.set(layer.key, { group: L.layerGroup(), entries });
      applyWanted();
    } catch (err) {
      console.warn(`Airspace ${layer.key} failed to load:`, err);
      onAirspaceStatus(layer.key, "unavailable");
    }
  }

  /** Show only areas/routes with some part inside the range ring (the selected one always stays). */
  function applyWanted() {
    for (const layer of AIRSPACE_LAYERS) {
      const g = groups.get(layer.key);
      if (!g) continue;
      g.group.clearLayers();
      let count = 0;
      for (const e of g.entries) {
        if (e.dist <= rangeNm) count++;
        if (e.dist <= rangeNm || e.props.id === selectedAirspaceId) g.group.addLayer(e.lyr);
      }
      onAirspaceStatus(layer.key, `${count}`);
      if (wanted.has(layer.key)) g.group.addTo(map);
      else map.removeLayer(g.group);
    }
  }

  /** Switch layers on/off to match `keys`; loads data on first use. */
  function setAirspace(keys, selectedId) {
    wanted = keys;
    for (const layer of AIRSPACE_LAYERS) if (wanted.has(layer.key)) ensureLayer(layer);
    applyWanted();
    if (selectedId !== selectedAirspaceId) {
      selectedAirspaceId = selectedId;
      for (const layer of AIRSPACE_LAYERS) groups.get(layer.key)?.entries.forEach((e) => e.lyr.setStyle(styleFor(layer, e.props)));
      applyWanted();
    }
  }

  // ---- fields ----
  let lastRender = null;
  let labelsOn = false;
  const LABEL_ZOOM = 6;

  function renderFields({ fields }, selectedFieldId, ringFor) {
    lastRender = [{ fields }, selectedFieldId, ringFor];
    labelsOn = map.getZoom() >= LABEL_ZOOM;
    pinLayer.clearLayers();
    for (const f of fields) {
      const status = fieldStatus(f);
      const selected = f.id === selectedFieldId;
      const ring = ringFor?.(f.code);
      const classes = ["field-pin", selected && "sel", f.outOfRange && "dim", f.searchHit && "hit"].filter(Boolean).join(" ");
      const marker = L.marker([f.lat, f.lon], {
        icon: L.divIcon({ className: classes, html: pinSvg({ towered: isTowered(f), military: isMilitary(f), status }), iconSize: [26, 26], iconAnchor: [13, 13] }),
        keyboard: false,
        riseOnHover: true,
        zIndexOffset: selected ? 1000 : f.searchHit ? 500 : 0,
      });
      marker.bindTooltip(
        `<b>${esc(f.code)}</b> — ${esc(f.name)}<br>${esc(f.city)} · ${Math.round(f.distanceNm)} nm${f.fbo ? `<br>${esc(f.fbo)}` : ""}<br>${isMilitary(f) ? "Military · " : ""}${isTowered(f) ? "Towered" : "Non-towered"}<br><span style="color:var(--muted)">${STATUS_LABELS[status]}</span>${f.rating?.n ? `<br><span style="color:var(--gold)">★ ${f.rating.avg ?? "–"}</span> <span style="color:var(--muted)">${f.rating.n} comment${f.rating.n === 1 ? "" : "s"}</span>` : ""}`,
        { className: "map-tooltip", direction: "top", offset: [0, -12] }
      );
      marker.on("click", () => onFieldClick(f.id));
      marker.addTo(pinLayer);
      // rated fields wear their average as a small gold label once zoomed in enough to read it
      if (labelsOn && f.rating?.avg) {
        L.marker([f.lat, f.lon], { icon: L.divIcon({ className: "rating-label", html: `★${f.rating.avg}`, iconSize: [34, 14], iconAnchor: [-12, 7] }), interactive: false, keyboard: false }).addTo(pinLayer);
      }

      const el = marker.getElement();
      if (el) {
        el.setAttribute("tabindex", "0");
        el.setAttribute("role", "button");
        el.setAttribute("data-field", f.id);
        if (ring) {
          el.setAttribute("data-ring", ring); // forecast flight category: MVFR or worse
          el.style.setProperty("--ring", ring);
        }
        el.setAttribute("aria-label", `${f.code} ${f.name}, ${f.city}, ${isMilitary(f) ? "military, " : ""}${isTowered(f) ? "towered" : "non-towered"}, ${STATUS_LABELS[status]}`);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onFieldClick(f.id);
          }
        });
      }
    }
  }

  const sizeMarks = () => document.getElementById("plannerMap").classList.toggle("z-low", map.getZoom() < 6);
  sizeMarks();
  map.on("zoomend", () => {
    sizeMarks();
    if (lastRender && labelsOn !== map.getZoom() >= LABEL_ZOOM) renderFields(...lastRender);
  });

  function setOrigin(o) {
    originMarker.setLatLng([o.lat, o.lon]);
    originMarker.setTooltipContent(`${o.name} (${o.icao})`);
    rangeCircle.setLatLng([o.lat, o.lon]);
    originPos = { lat: o.lat, lon: o.lon };
    for (const g of groups.values()) for (const e of g.entries) e.dist = distanceToGeometryNm(e.geom, originPos);
    applyWanted();
    map.flyTo([o.lat, o.lon], map.getZoom(), { duration: 0.6 });
  }

  return {
    renderFields,
    setAirspace,
    setOrigin,
    updateRange: (nm) => {
      if (nm === rangeNm) return;
      rangeNm = nm;
      rangeCircle.setRadius(nm * 1852);
      applyWanted();
    },
    getAirspace: (id) => featuresById.get(id) || null,
    // an airspace id from a shared link needs its file loaded before it can be shown
    ensureAirspaceData: (id) => (id?.startsWith("TFR:") ? loadFile("tfr") : id?.startsWith("MOA:") || /^[RWA]:/.test(id || "") ? loadFile("sua") : id ? loadFile("mtr") : Promise.resolve()),
    /** Draw the trip: [[lat, lon], …] from base through the stops (and back). */
    setTrip: (points) => tripLine.setLatLngs(points),
    map,
    invalidateSize: () => map.invalidateSize(),
    flyTo: (lat, lon) => map.flyTo([lat, lon], Math.max(map.getZoom(), 10), { duration: 0.6 }),
    /** Frame several points (search matches) without zooming past regional level. */
    fitTo: (points) => map.flyToBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 9, duration: 0.6 }),
    legendHtml,
  };
}
