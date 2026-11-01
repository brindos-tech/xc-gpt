// The planner's detail sheet — one panel for either a field or an airspace
// area/route. Same slide-over (desktop) / bottom-sheet (phone) behaviour as
// the events page's panel, with its own elements.
import { formatFlightTime } from "../format.js";
import { greatCircleNm, flightMinutes } from "../geo.js";
import { CAT_NAMES, CAT_COLORS, ceilingText, visText, precipText, ICE_LABELS, THUN_LABELS } from "./wx-model.js";
import { APPROACH_TYPES } from "./approaches.js";
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

const FUEL_CAP = 6;

/** The model forecast at the field for the selected day (3-hourly, local time). */
function forecastHtml(rows, tripDate) {
  if (!rows) return "";
  const day = tripDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const iceFlag = (r) => [r.lice ? `low ${ICE_LABELS[r.lice]}` : "", r.hice ? `high ${ICE_LABELS[r.hice]}` : ""].filter(Boolean).join(", ") || "—";
  return `<div class="fp-wx">
    <h5>Forecast at the field · ${esc(day)}</h5>
    <div class="fp-wx-scroll"><table class="fp-wx-table">
      <thead><tr><th>Local</th><th>Cat</th><th>Ceiling</th><th>Vis</th><th>Icing</th><th>TS</th><th>Precip</th><th>°F</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr><td>${esc(r.time)}</td><td><b style="color:${CAT_COLORS[r.cat]}">${CAT_NAMES[r.cat]}</b></td><td>${esc(ceilingText(r.ceil))}</td><td>${esc(visText(r.vis))}</td><td>${esc(iceFlag(r))}</td><td>${r.thun ? esc(THUN_LABELS[r.thun]) : "—"}</td><td>${esc(precipText(r.prec))}</td><td>${r.tF ?? "—"}</td></tr>`
        )
        .join("")}</tbody>
    </table></div>
    <div class="muted small">Model-derived estimate for the nearest grid point — a planning aid, not a weather brief. Get a standard briefing before you fly.</div>
  </div>`;
}

/** Published instrument approaches, tagged by training type; the list folds away. */
function approachesHtml(f) {
  const list = f.approaches || [];
  if (!list.length) return "";
  const types = (f.approachTypes || []).map((k) => APPROACH_TYPES.find((t) => t.key === k)?.label).filter(Boolean);
  return `<details class="fp-notes fp-approaches">
    <summary>Instrument approaches (${list.length}) · ${esc(types.join(", ") || "—")}</summary>
    <ul class="fp-app-list">${list.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
    <div class="muted small">FAA civil charts (d-TPP). Military-only procedures aren’t included — check FLIP.</div>
  </details>`;
}

function hotelHtml(f, tripDate) {
  if (!f.city) return "";
  const h = hotelLinks(f.city, tripDate);
  const night = tripDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `<div class="fp-hotels">
    <h5>Hotels · night of ${night}</h5>
    <div class="fp-links">
      <a href="${h.marriott}" target="_blank" rel="noopener noreferrer">Marriott · gov/mil rate ↗</a>
      <a href="${h.hilton}" target="_blank" rel="noopener noreferrer">Hilton search ↗</a>
      <a href="${h.hiltonGov}" target="_blank" rel="noopener noreferrer">Hilton gov/mil rates ↗</a>
    </div>
    <div class="muted small">One-night search for ${esc(f.city)}. Marriott is sent with the government (GOV) rate code. On Hilton, choose Government or Military under Special Rates after dates load. Availability and price aren’t checked here; bring orders/ID for the rate.</div>
  </div>`;
}

function merchantRow(m) {
  const tel = telHref(m.phone);
  const tag = m.contract ? `<span class="badge best-match">DLA contract</span>` : m.onSite ? `<span class="badge">on-site</span>` : `<span class="badge">delivers</span>`;
  return `<div class="fp-merchant">
    <div><b>${esc(m.merchant)}</b> ${tag}</div>
    <div class="muted small">${esc(m.fuels.join(", ") || "fuels not listed")}${m.phone ? ` · ${tel ? `<a href="${tel}">${esc(m.phone)}</a>` : esc(m.phone)}` : ""}${m.updated ? ` · updated ${esc(m.updated)}` : ""}</div>
  </div>`;
}

/** AIR Card merchants: contract and on-site first; the long off-site tail folds away. */
function merchantsHtml(f) {
  const all = f.aircard || [];
  if (!all.length) return "";
  const head = all.filter((m) => m.contract || m.onSite);
  const tail = all.filter((m) => !m.contract && !m.onSite);
  return `<details class="fp-notes fp-merchants" ${head.length ? "open" : ""}>
    <summary>AIR Card merchants (${all.length})</summary>
    ${head.slice(0, FUEL_CAP).map(merchantRow).join("") || `<div class="muted small">No on-site merchant listed.</div>`}
    ${tail.length ? `<details class="fp-more"><summary>${tail.length} off-site supplier${tail.length === 1 ? "" : "s"} (fuel delivered)</summary>${tail.slice(0, 12).map(merchantRow).join("")}</details>` : ""}
    <div class="muted small">AIR Card merchant export — re-exported periodically; call to confirm before you go.</div>
  </details>`;
}

const pad = (n) => String(n).padStart(2, "0");

/** One-night search links for the field's city, arriving on the trip date. */
export function hotelLinks(city, tripDate) {
  const out = new Date(tripDate.getFullYear(), tripDate.getMonth(), tripDate.getDate() + 1);
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const us = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
  const q = encodeURIComponent(city);
  return {
    marriott: `https://www.marriott.com/search/default.mi?searchType=InCity&destinationAddress.destination=${q}&fromDate=${encodeURIComponent(us(tripDate))}&toDate=${encodeURIComponent(us(out))}&numberOfRooms=1&numberOfGuests=1&clusterCode=GOV`,
    hiltonGov: "https://www.hilton.com/en/p/government-military-rates",
    hilton: `https://www.hilton.com/en/search/?query=${q}&arrivalDate=${iso(tripDate)}&departureDate=${iso(out)}&flexibleDates=false&numRooms=1&numAdults=1`,
  };
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
    ${row("Gov't fuel", `<span class="${gfc.level === "contract" ? "ok-text" : gfc.level === "none" ? "bad-text" : gfc.level === "unknown" ? "muted" : ""}">${esc(gfc.text)}</span>`)}
    ${gfc.conflict ? `<div class="fp-conflict">${esc(gfc.conflictText)}</div>` : ""}
    ${merchantsHtml(f)}
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
    ${forecastHtml(ctx.wxRows, tripDate)}
    <div class="fp-perdiem">
      <h5>GSA per diem · ${MONTHS[tripDate.getMonth()]}</h5>
      ${pd ? `<div class="fp-pd"><div><b>$${pd.lodging ?? "—"}</b><span>lodging / night</span></div><div><b>$${pd.meals ?? "—"}</b><span>meals &amp; incidentals</span></div></div><div class="muted small">${esc(pd.area)} · FY${pd.fy}${f.county ? ` · ${esc(f.county)} Co.` : ""}</div>` : `<div class="muted small">No FY${tripDate.getMonth() >= 9 ? tripDate.getFullYear() + 1 : tripDate.getFullYear()} rate found for this field's county.</div>`}
    </div>
    ${approachesHtml(f)}
    ${hotelHtml(f, tripDate)}
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
  const scroller = document.getElementById("fieldScroll");
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
    scroller.scrollTop = 0;
    setOpen(true);
    if (opening) closeBtn.focus({ preventScroll: true }); // the sheet is still sliding in off-screen; a plain focus() scrolls the clipped map area sideways to reveal it
  }

  return { render, close };
}

