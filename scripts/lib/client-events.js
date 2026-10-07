// Shapes merged events for data/generated/events.json — the file every
// visitor downloads. Keeps exactly what the browser and the CI checks
// (validate.js, check-links.js) read, and nothing else: at ~25k events,
// fields the page never looks at (venue, timestamps, source ids) and
// Ticketmaster's box-office boilerplate descriptions were most of the
// download.
//
// Defaults are omitted rather than written out — every reader already
// treats a missing end as "same day as start", missing artistIds as none,
// and a missing isFavoriteArtist / recurringId as falsy.

export function toClientEvent(ev) {
  const out = {
    id: ev.id,
    title: ev.title,
    start: ev.start,
  };
  if (ev.end && ev.end !== ev.start) out.end = ev.end;
  out.placeId = ev.placeId;
  out.category = ev.category;
  out.scale = ev.scale;
  out.confidence = ev.confidence;
  const url = ev.url || ev.ticketUrl;
  if (url) out.url = url;
  if (ev.artistIds?.length) out.artistIds = ev.artistIds;
  if (ev.isFavoriteArtist) out.isFavoriteArtist = true;
  if (ev.recurringId) out.recurringId = ev.recurringId;
  // Hand-picked (seed or recurring) rather than pulled from a feed — the
  // page treats these as highlights whatever their category (importance.js).
  if (ev.source === "curated" || ev.source === "recurring") out.curated = true;
  // Hand-written descriptions are worth searching on; Ticketmaster's are
  // overwhelmingly will-call / bag-policy / age-limit text that is the same
  // for every show at a venue.
  if (ev.description && ev.source !== "ticketmaster") out.description = ev.description;
  return out;
}

/** Local-calendar YYYY-MM-DD, matching how event dates are written. */
export function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** An event is still worth shipping until the last day it runs has passed. */
export function isUpcoming(ev, today) {
  return (ev.end || ev.start) >= today;
}
