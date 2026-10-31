// The planner's detail sheet — one panel for either a field or an airspace
// area/route. Same slide-over (desktop) / bottom-sheet (phone) behaviour as
// the events page's panel, with its own elements.
import { formatFlightTime } from "../format.js";
import { greatCircleNm, flightMinutes } from "../geo.js";
import { gfcStatus, perDiemFor, telHref, STATUS_LABELS, fieldStatus } from "./fields.js";
import { airspaceRows, typeName } from "./airspace.js";
import { esc } from "./html.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const approvalClass = (v) => (v === "Approved" ? "ok" : v === "Not Approved" ? "bad" : "warn");

function approvalCell(label, value) {
  return `<div class="fp-cell ${approvalClass(value)}"><span>${label}</span><b>${esc(value || "—")}</b></div>`;
}

function row(label, valueHtml) {
  return valueHtml ? `<div class="fp-row"><span>${label}</span><div>${valueHtml}</div></div>` : "";
}

export function fieldHtml(f, ctx) {
  const { origin, config, tripDate } = ctx;
  const distanceNm = greatCircleNm(origin, f);
  const mins = flightMinutes(distanceNm, config.aircraft.cruiseKts);
  const gfc = gfcStatus(f);
  const pd = perDiemFor(f, tripDate);
  const tel = telHref(f.fboPhone);
  const status = fieldStatus(f);
  const rwy = f.runway ? `${esc(f.runway.id)} · ${f.runway.len.toLocaleString("en-US")}′ × ${f.runway.width}′ ${esc(f.runway.surface)}` : null;

  return `
    <h3>${esc(f.code)} · ${esc(f.name)}</h3>
    <div class="dp-dist">${esc(f.city)} · ${Math.round(distanceNm)} nm from ${esc(origin.icao)} · ${formatFlightTime(mins)}</div>
    <div class="fp-badges">
      <span class="badge">${esc(f.classification)}</span>
      ${f.approvalList && f.approvalList !== "None" ? `<span class="badge best-match">${esc(f.approvalList)}</span>` : ""}
      ${(f.suitability || []).map((s) => `<span class="badge">${esc(s)}</span>`).join("")}
    </div>
    <div class="fp-grid" title="${esc(STATUS_LABELS[status])}">
      ${approvalCell("Land", f.land)}${approvalCell("Fuel", f.fuel)}${approvalCell("RON", f.ron)}
    </div>
    ${row("FBO", f.fbo ? `${esc(f.fbo)}${f.fboPhone ? ` · ${tel ? `<a href="${tel}">${esc(f.fboPhone)}</a>` : esc(f.fboPhone)}` : ""}` : `<span class="muted">None listed${f.classification.startsWith("Military") ? " (military field — use base ops)" : ""}</span>`)}
    ${row("Gov't fuel", `<span class="${gfc.known ? (gfc.has ? "ok-text" : "bad-text") : "muted"}">${esc(gfc.text)}</span>`)}
    ${f.notes ? `<div class="fp-notes"><h5>Nav info list notes</h5><div>${esc(f.notes)}</div></div>` : ""}
    <div class="fp-facts">
      <h5>FAA data</h5>
      ${row("Runway", rwy)}
      ${row("Elevation", f.elevFt != null ? `${f.elevFt.toLocaleString("en-US")}′` : null)}
      ${row("Tower", f.tower ? esc(f.tower === "NON-ATCT" ? "Non-towered" : f.tower) : null)}
      ${row("Fuel types", f.fuelTypes?.length ? esc(f.fuelTypes.join(", ")) : null)}
      ${row("Attended", f.attendance ? esc(f.attendance) : null)}
      ${row("Hangar", f.hangar ? "Transient hangar available" : null)}
      ${row("Landing fee", f.landingFee === true ? "Yes" : f.landingFee === false ? "None listed" : null)}
    </div>
    <div class="fp-perdiem">
      <h5>GSA per diem · ${MONTHS[tripDate.getMonth()]}</h5>
      ${pd ? `<div class="fp-pd"><div><b>$${pd.lodging ?? "—"}</b><span>lodging / night</span></div><div><b>$${pd.meals ?? "—"}</b><span>meals &amp; incidentals</span></div></div><div class="muted small">${esc(pd.area)} · FY${pd.fy}${f.county ? ` · ${esc(f.county)} Co.` : ""}</div>` : `<div class="muted small">No FY${tripDate.getMonth() >= 9 ? tripDate.getFullYear() + 1 : tripDate.getFullYear()} rate found for this field's county.</div>`}
    </div>
    <div class="fp-links">
      <a href="https://www.airnav.com/airport/${encodeURIComponent(f.code)}" target="_blank" rel="noopener noreferrer">AirNav ↗</a>
      <a href="https://skyvector.com/airport/${encodeURIComponent(f.code)}" target="_blank" rel="noopener noreferrer">SkyVector ↗</a>
    </div>
    ${f.listedAs ? `<div class="muted small">Listed as ${esc(f.listedAs)} on the nav info list.</div>` : ""}
    <div class="fp-disclaimer">Planning reference only. Confirm hours, fuel and PPR with the FBO / base ops, and check the current list and NOTAMs, before you go.</div>`;
}

export function airspaceHtml(p) {
  const rows = airspaceRows(p).map(([k, v]) => row(esc(k), esc(v))).join("");
  return `
    <h3>${esc(p.name)}</h3>
    <div class="dp-dist">${esc(typeName(p.type))}</div>
    <div class="fp-facts">${rows || `<div class="muted small">No details on file.</div>`}</div>
    ${p.sop ? `<details class="fp-notes"><summary>Special operating procedures</summary><div>${esc(p.sop)}</div></details>` : ""}
    ${p.remarks ? `<details class="fp-notes"><summary>Remarks</summary><div>${esc(p.remarks)}</div></details>` : ""}
    <div class="fp-disclaimer">From FAA data and DoD FLIP AP/1A &amp; AP/1B (eff. 3 Sep 2026). Planning reference only — use current FLIP, NOTAMs and the scheduling activity for actual use.</div>`;
}

export function createFieldPanel({ store }) {
  const panel = document.getElementById("fieldPanel");
  const content = document.getElementById("fieldContent");
  const closeBtn = document.getElementById("fieldClose");
  const backdrop = document.getElementById("fieldBackdrop");

  function setOpen(open) {
    panel.classList.toggle("open", open);
    backdrop.classList.toggle("open", open);
  }

  function close() {
    setOpen(false);
    store.setState({ selectedFieldId: null, selectedAirspaceId: null });
    setTimeout(() => document.querySelector(".tab-bar button.active")?.focus(), 0);
  }

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) close();
  });

  /** One of field / airspace / neither. */
  function render({ field, airspace, ctx }) {
    if (!field && !airspace) {
      setOpen(false);
      return;
    }
    const opening = !panel.classList.contains("open");
    content.innerHTML = field ? fieldHtml(field, ctx) : airspaceHtml(airspace);
    content.scrollTop = 0;
    setOpen(true);
    if (opening) closeBtn.focus({ preventScroll: true }); // the sheet is still sliding in off-screen; a plain focus() scrolls the clipped map area sideways to reveal it
  }

  return { render, close };
}

