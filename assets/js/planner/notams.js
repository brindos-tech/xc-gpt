// Show-stopper NOTAMs for the crew card: closures that change whether a field
// is usable (airport or runway closed, fuel unavailable). The text is picked
// out of the FAA NOTAM API results by scripts/fetch-notams.js; this module is
// the shared pure part (classification, dates, what to print).

/** What kind of show-stopper this NOTAM text is, or null when it is not one (taxiway, lighting, approach and similar are left out on purpose). */
export function showStopper(text) {
  const t = String(text || "").toUpperCase().replace(/\s+/g, " ");
  if (!t) return null;
  if (/\bAD AP CLSD\b|\bAIRPORT (CLSD|CLOSED)\b|\bAD CLSD\b|\bAERODROME (CLSD|CLOSED)\b/.test(t)) return "Airport closed";
  // "RWY 17/35 CLSD", "RWY 17L CLSD", "RWY 17/35 CLSD EXC ..." — but not "TWY ... CLSD" or "RWY ... EDGE LGT U/S"
  if (/\bRWY\s+[0-9]{1,2}[LRC]?(\/[0-9]{1,2}[LRC]?)?(\s*(AND|,)\s*[0-9]{1,2}[LRC]?(\/[0-9]{1,2}[LRC]?)?)*\s+(CLSD|CLOSED)\b/.test(t) || /\bRUNWAY\s+\S+\s+(CLSD|CLOSED)\b/.test(t)) return "Runway closed";
  if (/\b(FUEL|AVGAS|100LL|JET ?A1?|JET FUEL)\b[^.]{0,40}\b(NOT AVBL|UNAVBL|NOT AVAILABLE|UNAVAILABLE|NA)\b|\bNO (FUEL|AVGAS|JET)/.test(t)) return "Fuel unavailable";
  return null;
}

/** NOTAM dates come as ISO strings, "YYMMDDHHMM" or "PERM". null = no end / unknown. */
export function parseNotamDate(v) {
  if (v == null || v === "" || /^PERM/i.test(String(v))) return null;
  const s = String(v).replace(/EST$/i, "").trim();
  if (/^\d{10}$/.test(s)) return new Date(Date.UTC(2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)), Number(s.slice(6, 8)), Number(s.slice(8, 10))));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One API item -> { id, location, text, start, end, type } (tolerates the item wrapper varying). */
export function extractNotam(item) {
  const n = item?.properties?.coreNOTAMData?.notam || item?.coreNOTAMData?.notam || item?.notam || item?.properties?.notam || null;
  if (!n) return null;
  const text = n.text || item?.properties?.coreNOTAMData?.notamTranslation?.[0]?.simpleText || "";
  return {
    id: n.id || [n.series, n.number].filter(Boolean).join("") || n.number || "",
    number: n.number || "",
    location: n.icaoLocation || n.location || "",
    text: String(text).replace(/\s+/g, " ").trim(),
    start: parseNotamDate(n.effectiveStart)?.toISOString() || null,
    end: parseNotamDate(n.effectiveEnd)?.toISOString() || null,
    type: n.type || "", // N new · R replace · C cancel
  };
}

/** Show-stoppers only, cancellations dropped. */
export const keepShowStoppers = (notams) => notams.filter((n) => n && n.type !== "C").map((n) => ({ ...n, kind: showStopper(n.text) })).filter((n) => n.kind);

/** In force at `at`, or starting within `aheadHours` of it. */
export function activeAt(n, at, aheadHours = 24) {
  const start = n.start ? new Date(n.start) : null;
  const end = n.end ? new Date(n.end) : null;
  return (!start || start <= new Date(at.getTime() + aheadHours * 3600000)) && (!end || end >= at);
}

const fmt = (iso) => (iso ? new Date(iso).toISOString().slice(5, 16).replace("T", " ") + "Z" : "");

/**
 * The crew card's NOTAM line for a field: the show-stoppers in force around `at`,
 * "none found" when the field was checked, or a "not checked" note.
 * @param {{builtAt:string, checked:string[], fields:Object<string,object[]>}|null} file
 */
export function notamLines(code, file, at, esc = (x) => x) {
  if (!file) return `<span class="cc-muted">NOTAM data not loaded — check NOTAMs before you go</span>`;
  const stamp = new Date(file.builtAt).toISOString().slice(0, 16).replace("T", " ") + "Z";
  if (!file.checked?.includes(code)) return `<span class="cc-muted">not checked — check NOTAMs before you go</span>`;
  const list = (file.fields?.[code] || []).filter((n) => activeAt(n, at));
  if (!list.length) return `None found (as of ${stamp}) <span class="cc-muted">— closures only; check NOTAMs before you go</span>`;
  return (
    list.map((n) => `<b>${esc(n.kind)}</b>: ${esc(n.text.length > 220 ? `${n.text.slice(0, 220)}…` : n.text)} <span class="cc-muted">${esc([n.number, n.start && fmt(n.start), n.end ? `– ${fmt(n.end)}` : "– until further notice"].filter(Boolean).join(" "))}</span>`).join("<br>") +
    `<br><span class="cc-muted">as of ${stamp}</span>`
  );
}
