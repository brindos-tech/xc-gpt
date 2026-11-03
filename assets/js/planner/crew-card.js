// The printable crew card: the trip's legs and, per stop, what a crew wants on
// paper (FBO + phone, approvals, gov't fuel, hours, per diem, tax note). Built
// into #crewCard, which only shows when printing. Planning reference only.
import { esc } from "./html.js";
import { formatFlightTime } from "../format.js";
import { gfcStatus, perDiemFor, fieldStatus, STATUS_LABELS } from "./fields.js";
import { sunHours } from "./field-panel.js";
import { APPROACH_TYPES } from "./approaches.js";
import { legFlags } from "./trip.js";
import { clock, zoneAbbr, zulu, tzLabel, clockShift } from "./sun.js";
import { CAT_NAMES, flightCategory, ceilingText } from "./wx-model.js";

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

const money = (n) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);

function stopHtml(s, i, ctx) {
  const f = s.field;
  const gfc = gfcStatus(f);
  const pd = perDiemFor(f, ctx.tripDate);
  const sh = sunHours(f, ctx.tripDate);
  const tax = ctx.stateTaxes?.[f.state];
  const contractMerchants = (f.aircard || []).filter((m) => m.contract || m.onSite).slice(0, 3);
  const types = (f.approachTypes || []).map((k) => APPROACH_TYPES.find((t) => t.key === k)?.label).filter(Boolean);
  const line = (k, v) => (v ? `<tr><th>${esc(k)}</th><td>${v}</td></tr>` : "");
  return `<section class="cc-stop">
    <h3>${i + 1}. ${esc(f.code)} — ${esc(f.name)} <small>${esc(f.city)}${s.ron ? " · RON" : ""}</small></h3>
    <table>
      ${line("Approvals", `Land <b>${esc(f.land || "—")}</b> · Fuel <b>${esc(f.fuel || "—")}</b> · RON <b>${esc(f.ron || "—")}</b> <span class="cc-muted">(${esc(STATUS_LABELS[fieldStatus(f)])})</span>`)}
      ${line("Classification", esc(f.classification) + (f.approvalList && f.approvalList !== "None" ? ` · ${esc(f.approvalList)}` : ""))}
      ${line("FBO", f.fbo ? `${esc(f.fbo)}${f.fboPhone ? ` · <b>${esc(f.fboPhone)}</b>` : ""}` : "None listed")}
      ${line("Gov't fuel", esc(gfc.text) + (contractMerchants.length ? `<br>${contractMerchants.map((m) => `${esc(m.merchant)}${m.phone ? ` ${esc(m.phone)}` : ""}${m.contract ? " (DLA contract)" : ""}`).join("<br>")}` : ""))}
      ${line("Runway", f.runway ? `${esc(f.runway.id)} · ${f.runway.len.toLocaleString("en-US")}′ × ${f.runway.width}′ ${esc(f.runway.surface)}` : "")}
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
          const wxNote = (code, instant) => {
            const f = ctx.forecastAt?.(code, instant);
            return f ? `<br><span class="cc-muted">${CAT_NAMES[flightCategory(f.ceil, f.vis)]}, ceiling ${esc(ceilingText(f.ceil))}</span>` : "";
          };
          const when = (instant, tz, withDay) => `${withDay ? `${esc(new Date(instant).toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }))} ` : ""}${esc(clock(instant, tz))} ${esc(zoneAbbr(instant, tz))}<br><b>${esc(zulu(instant).text)}</b>`;
          return `<tr><td>${esc(l.from)} → ${esc(l.to)}${l.overRange ? `<br><span class="cc-flag">⚠ Tight on gas</span>` : ""}${shift?.text ? `<br><span class="cc-tz">${esc(shift.text)}</span>` : ""}${flags}</td>
            <td>${sc ? when(sc.dep, sc.fromTz, true) + wxNote(sc.from, sc.dep) : ""}</td>
            <td>${sc ? when(sc.eta, sc.toTz, sc.etaLocal.date !== sc.depLocal.date) + wxNote(sc.to, sc.eta) : ""}</td>
            <td>${Math.round(l.nm)} nm</td><td>${formatFlightTime(l.mins)}</td></tr>`;
        })
        .join("")}
      <tr class="cc-total"><td>Total</td><td></td><td></td><td>${Math.round(ctx.legs.totalNm)} nm</td><td>${formatFlightTime(ctx.legs.totalMins)}</td></tr>
    </tbody></table>
    ${ctx.cost.nights ? `<p class="cc-cost">${ctx.cost.nights} night${ctx.cost.nights === 1 ? "" : "s"}: lodging ${money(ctx.cost.lodging)} + M&amp;IE ${money(ctx.cost.meals)} = <b>${money(ctx.cost.total)}</b> <span class="cc-muted">(GSA rates, estimate — actual per diem per JTR/DTS)</span></p>` : ""}
    ${ctx.stops.map((s, i) => stopHtml(s, i, ctx)).join("")}
    <p class="cc-foot">Planning reference only — verify hours, fuel, PPR and approvals in FLIP, the current Nav Info List and ForeFlight, and check NOTAMs/TFRs and weather before you go.${ctx.dataNotes?.length ? `<br>${ctx.dataNotes.map(esc).join(" · ")}` : ""}<br>Printed ${esc(new Date().toLocaleString("en-US"))} from the XC GPT Nav Planner.</p>`;
}
