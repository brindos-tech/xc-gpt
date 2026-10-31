import { formatFlightTime, formatDateRange, decodeEntities } from "../format.js";

const CATEGORY_COLORS = {
  concert: "var(--cat-concert)", festival: "var(--cat-festival)", rodeo: "var(--cat-rodeo)",
  fair: "var(--cat-fair)", sports: "var(--cat-sports)", art: "var(--cat-art)", food: "var(--cat-food)",
  outdoors: "var(--cat-outdoors)", holiday: "var(--cat-holiday)", misc: "var(--cat-misc)",
};

function resolveVar(cssVar) {
  return getComputedStyle(document.documentElement).getPropertyValue(cssVar.match(/--[\w-]+/)[0]).trim();
}

export function createMapView({ config, origin }) {
  const mapEl = document.getElementById("mapWrap");
  const legendEl = document.getElementById("mapLegend");

  // SVG renderer (the default), not canvas: at ~87 places, real DOM nodes
  // per pin cost nothing measurable, and it's the only way a pin can be
  // keyboard-focused or reached by a screen reader — canvas-drawn shapes
  // have no DOM node to attach tabindex/keyboard handlers to at all.
  const map = L.map(mapEl, { zoomControl: true }).setView(
    [origin.lat, origin.lon],
    5
  );

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap",
    maxZoom: 12,
  }).addTo(map);

  // Origin marker
  const originMarker = L.circleMarker([origin.lat, origin.lon], {
    radius: 6, color: "#fff", fillColor: "#fff", fillOpacity: 1, weight: 2,
  })
    .bindTooltip(`${origin.name} (${origin.icao})`, { className: "map-tooltip" })
    .addTo(map);

  // Range ring
  let rangeCircle = L.circle([origin.lat, origin.lon], {
    radius: config.defaults.rangeNm * 1852,
    color: "#ff8a3d", weight: 1.5, dashArray: "6,6", fill: false, opacity: 0.6,
  }).addTo(map);

  const pinLayer = L.layerGroup().addTo(map);
  let onPinClick = () => {};

  function updateRange(rangeNm) {
    rangeCircle.setRadius(rangeNm * 1852);
  }

  // Switching departure base moves the range ring's center — a gentle pan
  // to the new origin (keeping the current zoom) so the ring's new position
  // doesn't just silently jump off-screen unnoticed.
  function setOrigin(newOrigin) {
    originMarker.setLatLng([newOrigin.lat, newOrigin.lon]);
    originMarker.setTooltipContent(`${newOrigin.name} (${newOrigin.icao})`);
    rangeCircle.setLatLng([newOrigin.lat, newOrigin.lon]);
    map.flyTo([newOrigin.lat, newOrigin.lon], map.getZoom(), { duration: 0.6 });
  }

  function render(visiblePlaces, allPlaces, state) {
    pinLayer.clearLayers();

    const shown = allPlaces.filter((p) => p.distanceNm <= state.rangeNm);
    const visibleIds = new Set(visiblePlaces.map((p) => p.id));

    for (const place of shown) {
      const inRule = visibleIds.has(place.id);
      const count = inRule ? place.eventCount || 0 : 0;
      const radius = count > 0 ? Math.min(6 + count * 1.5, 20) : 5;
      const dominantCategory = inRule && place.topEvent ? place.topEvent.category : null;
      const color = dominantCategory ? resolveVar(CATEGORY_COLORS[dominantCategory] || CATEGORY_COLORS.misc) : "#4a5568";

      const marker = L.circleMarker([place.lat, place.lon], {
        radius,
        color: inRule ? color : "#4a5568",
        fillColor: inRule ? color : "transparent",
        fillOpacity: count > 0 ? 0.75 : 0.15,
        weight: count > 0 ? 2 : 1.5,
        opacity: inRule ? 1 : 0.35,
      });

      // Up to 3 events, best-first (place.rankedEvents is sorted by
      // eventScore in filters.js — non-highlight events score 0, so a
      // favorite-artist show or pro/SEC game always leads when one exists)
      // — not just the single top pick, so a quick hover shows a spread of
      // what's actually happening there across a few dates.
      const topEvents = place.rankedEvents ? place.rankedEvents.slice(0, 3) : [];
      const eventLinesHtml = topEvents
        .map((e) => `<br><span style="color:var(--gold)">${formatDateRange(e.start, e.end)} — ${decodeEntities(e.title)}</span>`)
        .join("");
      marker.bindTooltip(
        `<b>${place.name}</b> — ${formatFlightTime(place.flightMinutes)}${count ? ` · ${count} event${count === 1 ? "" : "s"}` : ""}${eventLinesHtml}`,
        { className: "map-tooltip", direction: "top", offset: [0, -6] }
      );
      marker.on("click", () => onPinClick(place.id));
      marker.addTo(pinLayer);

      // Keyboard access: circleMarker gives no focus/keyboard handling out
      // of the box, even rendered as real SVG. Wire it up manually so the
      // map isn't mouse-only.
      const el = marker.getElement();
      if (el) {
        el.setAttribute("tabindex", "0");
        el.setAttribute("role", "button");
        el.setAttribute("data-place", place.id);
        const summary = `${place.name}${count ? `, ${count} event${count === 1 ? "" : "s"}` : ", no events in window"}`;
        el.setAttribute("aria-label", summary);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPinClick(place.id);
          }
        });
      }
    }
  }

  function renderLegend() {
    const entries = Object.entries(CATEGORY_COLORS).slice(0, 6);
    legendEl.innerHTML = entries
      .map(([cat, color]) => `<span><span class="legend-dot" style="background:${resolveVar(color)}"></span>${cat}</span>`)
      .join("") + `<span><span class="legend-dot" style="background:#4a5568;opacity:.5"></span>no events in window</span>`;
  }

  renderLegend();

  return {
    render,
    updateRange,
    setOrigin,
    invalidateSize: () => map.invalidateSize(),
    onPinClick: (fn) => { onPinClick = fn; },
    flyTo: (lat, lon) => map.flyTo([lat, lon], 7, { duration: 0.6 }),
  };
}
