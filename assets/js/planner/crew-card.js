// The printable crew card: the trip's legs and, per stop, what a crew wants on
// paper (FBO + phone, approvals, gov't fuel, hours, per diem, tax note). Built
// into #crewCard, which only shows when printing. Planning reference only.
import { esc } from "./html.js";
import { formatFlightTime, parseDate } from "../format.js";
import { gfcStatus, perDiemFor, fieldStatus, STATUS_LABELS } from "./fields.js";
import { sunHours } from "./field-panel.js";
import { APPROACH_TYPES } from "./approaches.js";
import { legFlags } from "./trip.js";
import { notamLines } from "./notams.js";
import { clock, zoneAbbr, zulu, tzLabel, clockShift } from "./sun.js";
import { CAT_NAMES, flightCategory, ceilingText } from "./wx-model.js";
import { alternateCheck, alternateReason } from "./ceiling-timeline.js";

/** The time zones along the trip, with what happens to your clock at each change. */
function zonesHtml(schedule) {
  if (!schedule?.length) return "";
  const points = [{ code: schedule[0].from, tz: schedule[0].fromTz, at: schedule[0].dep, shift: null }];
  schedule.forEach((l) => points.push({ code: l.to, tz: l.toTz, at: l.eta, shift: clockShift(l.fromTz, l.dep, l.toTz, l.eta) }));
  const rows = points.map((p) => `<tr><td>${esc(p.code)}</td><td>${esc(tzLabel(p.tz, p.at))}</td><td>${p.shift?.text ? `<span class="cc-tz">${p.shift.kind === "gain" ? "Gain" : "Lose"} ${Number.isInteger(Math.abs(p.shift.minutes) / 60) ? `${Math.abs(p.shift.minutes) / 60} hr` : `${Math.abs(p.shift.minutes)} min`}</span>` : ""}</td></tr>`).join("");
  const zones = new Set(points.map((p) => p.tz));
  return `<table class="cc-zones"><thead><tr><th colspan="3">Time zones${zones.size > 1 ? ` — ${zones.size} zones on this trip` : " — all one zone"}</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="cc-zulu cc-muted">Zulu (UTC) times are in bold below.</p>`;
}

const rwyText = (r) => `${esc(r.id)} · ${r.len.toLocaleString("en-US")}′ × ${r.width}′ ${esc(r.surface || "")}`.trim();

/** Every runway at least 4,000′ × 75′ (the NASR list); older data with only the longest runway falls back to that one. */
export function runwaysHtml(f) {
  const list = f.runways ?? (f.runway ? [f.runway] : []);
  return list.map(rwyText).join("<br>");
}

const ARTCC_NAMES = { ZAB: "Albuquerque", ZAU: "Chicago", ZBW: "Boston", ZDC: "Washington", ZDV: "Denver", ZFW: "Fort Worth", ZHU: "Houston", ZID: "Indianapolis", ZJX: "Jacksonville", ZKC: "Kansas City", ZLA: "Los Angeles", ZLC: "Salt Lake City", ZMA: "Miami", ZME: "Memphis", ZMP: "Minneapolis", ZNY: "New York", ZOA: "Oakland", ZOB: "Cleveland", ZSE: "Seattle", ZTL: "Atlanta" };

/** Who you talk to at the field: tower, approach control (TRACON / RAPCON / RATCF / approach-control tower) and the overlying center. */
export function controlInfo(f) {
  const t = String(f.tower || "");
  const approach = /TRACON|RAPCON|RATCF|TRACAB|A\/C/.test(t);
  const centerName = f.artcc?.name || ARTCC_NAMES[f.artcc?.id] || "";
  const center = f.artcc?.id ? `${f.artcc.id}${centerName ? ` ${centerName}` : ""} Center` : "";
  if (!t) return center ? { text: center, flagged: true } : null;
  if (/^NON/.test(t)) return { text: `No tower · ${center ? `center control (${center})` : "center control"}`, flagged: true };
  if (approach) return { text: `Tower + approach control (${t.replace(/^ATCT-?/, "") || "approach"})${center ? ` · ${center}` : ""}`, flagged: true };
  return { text: `Tower only, no approach control at the field${center ? ` · ${center}` : ""}`, flagged: false };
}

/** Runway ends with right-hand traffic, e.g. "17, 35L"; "" when there are none. */
export const rightTrafficText = (f) => (f.rightTraffic?.length ? f.rightTraffic.join(", ") : "");

const money = (n) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);

function stopHtml(s, i, ctx) {
  const f = s.field;
  const gfc = gfcStatus(f);
  // everything dated at this stop (sun, FBO hours, the month's per diem) is for the day the crew arrives, not the trip's first day
  const arrives = ctx.schedule?.[i]?.etaLocal?.date;
  const day = arrives ? parseDate(arrives) : ctx.tripDate;
  const pd = perDiemFor(f, day);
  const sh = sunHours(f, day);
  const tax = ctx.stateTaxes?.[f.state];
  const contractMerchants = (f.aircard || []).filter((m) => m.contract || m.onSite).slice(0, 3);
  const types = (f.approachTypes || []).map((k) => APPROACH_TYPES.find((t) => t.key === k)?.label).filter(Boolean);
  const line = (k, v) => (v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : "");
  return `<section class="cc-stop">
    <h3>${i + 1}. ${esc(f.code)} — ${esc(f.name)} <small>${esc(f.city)}${s.ron ? " · RON" : ""}${arrives ? ` · arrive ${esc(day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }))}` : ""}</small></h3>
    <table>
      ${line("Approvals", `Land <b>${esc(f.land || "—")}</b> · Fuel <b>${esc(f.fuel || "—")}</b> · RON <b>${esc(f.ron || "—")}</b> <span class="cc-muted">(${esc(STATUS_LABELS[fieldStatus(f)])})</span>`)}
      ${line("Classification", esc(f.classification) + (f.approvalList && f.approvalList !== "None" ? ` · ${esc(f.approvalList)}` : ""))}
      ${line("FBO", f.fbo ? `${esc(f.fbo)}${f.fboPhone ? ` · <b>${esc(f.fboPhone)}</b>` : ""}` : "None listed")}
      ${line("Gov't fuel", esc(gfc.text) + (contractMerchants.length ? `<br>${contractMerchants.map((m) => `${esc(m.merchant)}${m.phone ? ` ${esc(m.phone)}` : ""}${m.contract ? " (DLA contract)" : ""}`).join("<br>")}` : ""))}
      ${f.elevFt != null ? line("Elevation", `<b class="cc-hi">${f.elevFt.toLocaleString("en-US")}′ MSL</b>`) : ""}
      ${(() => {
        const c = controlInfo(f);
        return c ? line("ATC", c.flagged ? `<b class="cc-hi">${esc(c.text)}</b>` : esc(c.text)) : "";
      })()}
      ${line("Runways", runwaysHtml(f))}
      ${rightTrafficText(f) ? line("Traffic pattern", `<b class="cc-hi">Right traffic: runway ${esc(rightTrafficText(f))}</b>`) : ""}
      ${ctx.notamsWanted ? line("Closures (NOTAM)", notamLines(f.code, ctx.notams, ctx.schedule?.[i]?.eta || new Date(), ctx.schedule?.[i + 1]?.dep || ctx.schedule?.[i]?.eta || new Date(), esc, ctx.now)) : ""}
      ${line("Approaches", esc(types.join(", ")))}
      ${sh ? line(`Sun (${sh.abbr || "local"})`, esc(sh.sunText)) : ""}
      ${sh ? line("FBO hours", esc(sh.hoursText || "not listed") + (f.attendance ? ` <span class="cc-muted">(${esc(f.attendance)})</span>` : "") + sh.flags.map((x) => `<br>⚠ ${esc(x.text)}`).join("")) : ""}
      ${pd ? line("Per diem", `lodging ${money(pd.lodging)} · M&amp;IE ${money(pd.meals)} <span class="cc-muted">(${esc(pd.area)}, FY${pd.fy})</span>`) : ""}
      ${tax ? line("Lodging tax", `${esc(tax.name)}: ${esc(tax.note)}${tax.form ? ` Form: ${esc(tax.form)}.` : ""}`) : ""}
      ${f.notes ? line("List notes", esc(f.notes.length > 420 ? `${f.notes.slice(0, 420)}…` : f.notes)) : ""}
    </table>
  </section>`;
}

/** @param {{origin, stops:{field, ron}[], legs:{legs:object[], totalNm:number, totalMins:number}, cost:object, tripDate:Date, route:string, stateTaxes:object, dataNotes:string[]}} ctx */
export function crewCardHtml(ctx) {
  const date = ctx.tripDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return `<div class="cc-head"><h2>Crew card · ${esc(ctx.origin.icao)} · ${esc(date)}</h2>
    <div class="cc-route">${esc(ctx.route)}</div></div>
    ${zonesHtml(ctx.schedule)}
    <table class="cc-legs"><thead><tr><th>Leg</th><th>Takeoff</th><th>Land</th><th>Distance</th><th>Flight time</th></tr></thead><tbody>
      ${ctx.legs.legs
        .map((l, i) => {
          const sc = ctx.schedule?.[i];
          const flags = sc ? legFlags(sc).map((x) => `<br><span class="cc-flag">⚠ ${esc(x.text)}</span>`).join("") : "";
          const shift = sc ? clockShift(sc.fromTz, sc.dep, sc.toTz, sc.eta) : null;
          const alt = sc && ctx.forecastAt ? alternateCheck(ctx.forecastAt, sc.to, sc.eta) : null;
          const altNote = alt ? `<br><span class="cc-flag">⚠ Alternate may be required (${esc(alternateReason(alt))} at ${esc(sc.to)})</span>` : "";
          const wxNote = (code, instant) => {
            const f = ctx.forecastAt?.(code, instant);
            if (!f) return "";
            const cat = flightCategory(f.ceil, f.vis);
            return `<br><span class="cc-muted">${CAT_NAMES[cat]}${cat > 0 ? `, ceiling ${esc(ceilingText(f.ceil))}` : ""}</span>`;
          };
          const when = (instant, tz, withDay) => `${withDay ? `${esc(new Date(instant).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }))} ` : ""}${esc(clock(instant, tz))} ${esc(zoneAbbr(instant, tz))}<br><b>${esc(zulu(instant).text)}</b>`;
          return `<tr><td>${esc(l.from)} → ${esc(l.to)}${l.overRange ? `<br><span class="cc-flag">⚠ Tight on gas</span>` : ""}${shift?.text ? `<br><span class="cc-tz">${esc(shift.text)}</span>` : ""}${altNote}${flags}</td>
            <td>${sc ? when(sc.dep, sc.fromTz, true) + wxNote(sc.from, sc.dep) : ""}</td>
            <td>${sc ? when(sc.eta, sc.toTz, sc.etaLocal.date !== sc.depLocal.date) + wxNote(sc.to, sc.eta) : ""}</td>
            <td>${Math.round(l.nm)} nm</td><td>${formatFlightTime(l.mins)}</td></tr>`;
        })
        .join("")}
      <tr class="cc-total"><td>Total</td><td></td><td></td><td>${Math.round(ctx.legs.totalNm)} nm</td><td>${formatFlightTime(ctx.legs.totalMins)}</td></tr>
    </tbody></table>
    ${ctx.cost.nights ? `<p class="cc-cost">${ctx.cost.nights} night${ctx.cost.nights === 1 ? "" : "s"}: lodging ${money(ctx.cost.lodging)} + M&amp;IE ${money(ctx.cost.meals)} = <b>${money(ctx.cost.total)}</b> <span class="cc-muted">(GSA rates, estimate — actual per diem per JTR/DTS)</span></p>` : ""}
    ${ctx.stops.map((s, i) => stopHtml(s, i, ctx)).join("")}
    <p class="cc-foot">Planning reference only — verify hours, fuel, PPR and approvals in FLIP, the current Nav Info List and ForeFlight, and check NOTAMs/TFRs and weather before you go.${ctx.dataNotes?.length ? `<br>${ctx.dataNotes.map(esc).join(" · ")}` : ""}<br>Printed ${esc(new Date().toLocaleString("en-US"))} from XC Scanner.</p>`;
}
