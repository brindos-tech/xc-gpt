// The first-visit welcome screen: a native <dialog> (Esc closes it, focus stays
// inside while it is open) shown once, remembered in localStorage, and
// reopened from the "How to use" button in the header.
import { pinSvg } from "../planner/planner-view.js";
import { WX_LAYERS } from "../planner/wx-controller.js";

const KEY = "xcgpt-welcome-seen";

const seen = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const remember = () => {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // shown again next time
  }
};

// Real fields near Vance for the example map (status dots as on the nav list).
const MAP_FIELDS = [
  { code: "KEND", lat: 36.3398, lon: -97.9172, towered: true, military: true, status: "go", label: "KEND · base" },
  { code: "KOKC", lat: 35.3931, lon: -97.6008, towered: true, status: "go", tip: "green dot: approved" },
  { code: "KSWO", lat: 36.1614, lon: -97.0859, towered: true, status: "go" },
  { code: "KPNC", lat: 36.732, lon: -97.0998, towered: false, status: "check", tip: "yellow dot: see comments" },
  { code: "KTUL", lat: 36.1984, lon: -95.8881, towered: true, status: "check" },
];
const NM = 1852;
let miniMap = null;

/** A small, fixed Leaflet map: real tiles, the base's range ring, the real pin marks and an example radar picture. */
function buildMiniMap() {
  const L = window.L;
  const el = document.getElementById("welcomeMap");
  if (!L || !el || miniMap) return;
  miniMap = L.map(el, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, zoomSnap: 0.25 });
  // frame every example field, with a little room around them
  miniMap.fitBounds([[35.25, -98.4], [36.9, -95.6]], { paddingTopLeft: [14, 26], paddingBottomRight: [14, 22] });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 12 }).addTo(miniMap);
  L.circle([36.3398, -97.9172], { radius: 70 * NM, color: "#ff8a3d", weight: 2, dashArray: "6,6", fill: false, interactive: false }).addTo(miniMap);
  // radar: a made-up squall line drawn in the standard NEXRAD colours (scripts/make-welcome-radar.mjs)
  L.imageOverlay("assets/img/welcome-radar.png", [[34.6, -100.4], [37.6, -94.2]], { opacity: 0.85, interactive: false }).addTo(miniMap);
  for (const f of MAP_FIELDS) {
    const m = L.marker([f.lat, f.lon], { icon: L.divIcon({ className: "wv-marker", html: pinSvg(f), iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false, keyboard: false }).addTo(miniMap);
    const text = f.label || f.tip;
    if (text) m.bindTooltip(text, { permanent: true, direction: "right", className: "wv-tip", offset: [8, 0] });
  }
}

export function initWelcome() {
  const dialog = document.getElementById("welcome");
  const openBtn = document.getElementById("helpBtn");
  if (!dialog || typeof dialog.showModal !== "function") return;
  // the example Weather box uses the real overlay names (Radar on, as it starts)
  const layers = dialog.querySelector("#wvLayers");
  if (layers) layers.innerHTML = WX_LAYERS.map((l) => `<span class="chip${l.key === "radar" ? " active" : ""}">${l.label}</span>`).join("");
  const days = dialog.querySelector("#wvDays");
  if (days) {
    const now = new Date();
    days.innerHTML = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<span class="chip${i === 0 ? " active" : ""}">${i === 0 ? "Today" : new Date(now.getFullYear(), now.getMonth(), now.getDate() + i).toLocaleDateString("en-US", { weekday: "short", day: "numeric" })}</span>`).join("");
  }
  // the example pins are the real map marks
  dialog.querySelectorAll("[data-wpin]").forEach((el) => {
    const kind = el.dataset.wpin;
    el.innerHTML = pinSvg({ towered: kind === "towered" || kind === "military", military: kind === "military", status: el.dataset.status || null });
  });
  const close = () => dialog.open && dialog.close();
  document.getElementById("welcomeGo").addEventListener("click", close);
  dialog.addEventListener("close", () => {
    remember();
    openBtn?.focus();
    dialog.querySelector(".welcome-card").scrollTop = 0;
  });
  // a click on the dimmed backdrop (outside the card) closes it too
  dialog.addEventListener("click", (e) => e.target === dialog && close());
  const open = () => {
    dialog.showModal();
    // Leaflet measures 0x0 inside a closed dialog
    requestAnimationFrame(() => {
      buildMiniMap();
      miniMap?.invalidateSize();
    });
  };
  openBtn?.addEventListener("click", open);
  if (!seen()) open();
}
