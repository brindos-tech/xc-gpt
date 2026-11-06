// Show-stopper NOTAMs for the crew card: closures that change whether a field
// is usable (airport or runway closed, fuel unavailable). The text is picked
// out of the NOTAM distribution feed by scripts/fetch-notams.js; this module is
// the shared pure part (classification, dates, what to print).

/** What kind of show-stopper this NOTAM text is, or null when it is not one (taxiway, lighting, approach and similar are left out on purpose). */
export function showStopper(text) {
  const t = String(text || "").toUpperCase().replace(/\s+/g, " ");
  if (!t) return null;
  if (/\bAD AP CLSD\b|\bAIRPORT (CLSD|CLOSED)\b|\bAD CLSD\b|\bAERODROME (CLSD|CLOSED)\b/.test(t)) return "Airport closed";
  // The NOTAM must be ABOUT a runway ("RWY 17/35 CLSD", "RWY 09/27 CLSD EXC TAX ..."), so "TWY A BTN TWY C AND APCH END RWY 35 CLSD"
  // and "TWY N RUNUP PAD FOR RWY 27 CLSD" (taxiways) do not count, nor does a weight limit ("CLSD TO ACFT OVER 12500 LBS").
  const subject = t.replace(/^!\S+\s+\d{1,2}\/\d{1,5}\s+\S+\s+/, "");
  const closed = "(CLSD|CLOSED)";
  const rwy = "[0-9]{1,2}[LRC]?(\\/[0-9]{1,2}[LRC]?)?";
  const aboutRunway = new RegExp(`^(RWY|RUNWAY)\\s+${rwy}(\\s*(AND|,)\\s*${rwy})*\\s+${closed}\\b`).test(subject);
  if (aboutRunway && !/\b(CLSD|CLOSED) TO (ACFT|AIRCRAFT)\b[^.]{0,30}\b(OVER|EXCEEDING|HEAVIER|WINGSPAN|WEIGHT|MORE THAN)\b/.test(subject)) return "Runway closed";
  if (/\b(FUEL|AVGAS|100LL|JET ?A1?|JET FUEL)\b[^.]{0,40}\b(NOT AVBL|UNAVBL|NOT AVAILABLE|UNAVAILABLE|NA)\b|\bNO (FUEL|AVGAS|JET)/.test(t)) return "Fuel unavailable";
  return null;
}

/** NOTAM dates come as ISO strings, "YYYYMMDDHHMM" (NMS), "YYMMDDHHMM" or "PERM". null = no end / unknown. */
export function parseNotamDate(v) {
  if (v == null || v === "" || /^PERM/i.test(String(v))) return null;
  const s = String(v).replace(/EST$/i, "").trim();
  if (/^\d{12}$/.test(s)) return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12))));
  if (/^\d{10}$/.test(s)) return new Date(Date.UTC(2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)), Number(s.slice(6, 8)), Number(s.slice(8, 10))));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Show-stoppers only, cancellations dropped; dates become ISO strings. */
export const keepShowStoppers = (notams) =>
  notams
    .filter((n) => n && n.type !== "C")
    .map((n) => ({ ...n, kind: showStopper(n.text), start: parseNotamDate(n.start)?.toISOString() || null, end: parseNotamDate(n.end)?.toISOString() || null }))
    .filter((n) => n.kind);

/** Does the NOTAM's period overlap [from, to]? No start means already in force; no end means until further notice. */
export function overlapsWindow(n, from, to) {
  const start = n.start ? new Date(n.start) : null;
  const end = n.end ? new Date(n.end) : null;
  return (!start || start <= to) && (!end || end >= from);
}

const fmt = (iso) => (iso ? new Date(iso).toISOString().slice(5, 16).replace("T", " ") + "Z" : "");
const fmtDate = (d) => d.toISOString().slice(5, 16).replace("T", " ") + "Z";

/**
 * The crew card's NOTAM line for a field: every show-stopper that overlaps the
 * crew's stay (arrival to their next takeoff, so closures that begin later in
 * the stay count), "none found" when the field was checked and is clear, or a
 * "not checked" note.
 * @param {{builtAt:string, checked:string[], fields:Object<string,object[]>}|null} file
 * @param {Date} from arrival
 * @param {Date} to   the next takeoff (equal to `from` when there is none)
 */
export function notamLines(code, file, from, to = from, esc = (x) => x) {
  if (!file) return `<span class="cc-muted">NOTAM data not loaded — check NOTAMs before you go</span>`;
  const stamp = new Date(file.builtAt).toISOString().slice(0, 16).replace("T", " ") + "Z";
  if (!file.checked?.includes(code)) return `<span class="cc-muted">not checked — check NOTAMs before you go</span>`;
  const stay = to > from ? `${fmtDate(from)} – ${fmtDate(to)}` : fmtDate(from);
  const list = (file.fields?.[code] || []).filter((n) => overlapsWindow(n, from, to)).sort((a, b) => String(a.start).localeCompare(String(b.start)));
  if (!list.length) return `None found for your stay, ${stay} (as of ${stamp}) <span class="cc-muted">— closures only; check NOTAMs before you go</span>`;
  const when = (n) => {
    const start = n.start ? new Date(n.start) : null;
    const end = n.end ? `until ${fmt(n.end)}` : "until further notice";
    if (start && start > from) return `<b>begins ${fmt(n.start)} — during your stay</b>, ${end}`;
    return `in force at arrival, ${end}`;
  };
  return (
    list.map((n) => `<b>${esc(n.kind)}</b>: ${esc(n.text.length > 220 ? `${n.text.slice(0, 220)}…` : n.text)}<br><span class="cc-muted">${esc(n.number || "")}</span> ${when(n)}`).join("<br>") +
    `<br><span class="cc-muted">stay ${stay} · as of ${stamp}</span>`
  );
}
