// The printable crew card: the trip's legs and, per stop, what a crew wants on
// paper (FBO + phone, approvals, gov't fuel, hours, per diem, tax note). Built
// into #crewCard, which only shows when printing. Planning reference only.
import { esc } from "./html.js";
import { formatFlightTime } from "../format.js";
import { gfcStatus, perDiemFor, fieldStatus, STATUS_LABELS } from "./fields.js";
import { sunHours } from "./field-panel.js";
import { APPROACH_TYPES } from "./approaches.js";

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
    <table class="cc-legs"><thead><tr><th>Leg</th><th>Distance</th><th>Flight time</th><th></th></tr></thead><tbody>
      ${ctx.legs.legs.map((l) => `<tr><td>${esc(l.from)} → ${esc(l.to)}</td><td>${Math.round(l.nm)} nm</td><td>${formatFlightTime(l.mins)}</td><td>${l.overRange ? "⚠ beyond one leg — plan a fuel stop" : ""}</td></tr>`).join("")}
      <tr class="cc-total"><td>Total</td><td>${Math.round(ctx.legs.totalNm)} nm</td><td>${formatFlightTime(ctx.legs.totalMins)}</td><td></td></tr>
    </tbody></table>
    ${ctx.cost.nights ? `<p class="cc-cost">${ctx.cost.nights} night${ctx.cost.nights === 1 ? "" : "s"}: lodging ${money(ctx.cost.lodging)} + M&amp;IE ${money(ctx.cost.meals)} = <b>${money(ctx.cost.total)}</b> <span class="cc-muted">(GSA rates, estimate — actual per diem per JTR/DTS)</span></p>` : ""}
    ${ctx.stops.map((s, i) => stopHtml(s, i, ctx)).join("")}
    <p class="cc-foot">Planning reference only — verify hours, fuel, PPR and approvals in FLIP, the current Nav Info List and ForeFlight, and check NOTAMs/TFRs and weather before you go.${ctx.dataNotes?.length ? `<br>${ctx.dataNotes.map(esc).join(" · ")}` : ""}<br>Printed ${esc(new Date().toLocaleString("en-US"))} from the XC GPT Nav Planner.</p>`;
}
