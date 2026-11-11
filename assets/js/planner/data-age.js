// How old each published data file is, and whether that is too old. The weather, TFR and NOTAM files are rebuilt
// by scheduled workflows; if one of those stops, the page keeps showing the last file as if it were current. This is
// the pure part: ages and wording. (The banner and the crew card use it.)

/** Past this many hours a source is "stale": its schedule would have refreshed it well before. */
export const MAX_AGE_HOURS = {
  forecast: 18, // rebuilt twice a day (05:43 and 17:43 UTC)
  tfr: 3, // rebuilt hourly
  notams: 30, // rebuilt once a day (09:23 UTC, retry 15:23)
};

export const SOURCE_LABELS = { forecast: "Forecast", tfr: "TFRs", notams: "NOTAMs" };

/** Hours since `builtAt` (an ISO string), or null when there is no usable time. Never negative (clock skew). */
export function ageHours(builtAt, now = new Date()) {
  const t = Date.parse(builtAt);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 3600000) : null;
}

/** "20 minutes", "5 hours", "2 days". */
export function ageText(hours) {
  if (hours < 1) {
    const m = Math.max(1, Math.round(hours * 60));
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  if (hours < 48) {
    const h = Math.round(hours);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(hours / 24);
  return `${d} days`;
}

/** Is this source's file older than its limit? A missing or untimed file is not "stale" (that is "not loaded"). */
export function isStale(source, builtAt, now = new Date()) {
  const h = ageHours(builtAt, now);
  return h != null && h > MAX_AGE_HOURS[source];
}

/** The stale sources among `builtAts` ({forecast, tfr, notams} -> ISO time or null), oldest first. */
export function staleSources(builtAts, now = new Date()) {
  return Object.keys(MAX_AGE_HOURS)
    .map((source) => ({ source, label: SOURCE_LABELS[source], hours: ageHours(builtAts?.[source], now) }))
    .filter((s) => s.hours != null && s.hours > MAX_AGE_HOURS[s.source])
    .map((s) => ({ ...s, text: ageText(s.hours) }))
    .sort((a, b) => b.hours - a.hours);
}

/** The banner sentence for a non-empty list from staleSources(). */
export function staleMessage(stale) {
  const parts = stale.map((s) => `${s.label} ${s.label === "TFRs" ? "are" : "is"} ${s.text} old`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${list} — a data refresh may have failed. Check official sources before you fly.`;
}
