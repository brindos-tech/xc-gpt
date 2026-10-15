import { parseDate, formatDateRange, formatFlightTime, decodeEntities, fridayOf, toDateKey } from "../format.js";

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Shown above the feed while the PR chip is on: unverified leads from the
// weekly web sweep and DVIDS flyover history (scripts/fetch-pr-leads.js).
// Links only — these are for a person to check, not events.
function prLeadsHtml(prLeads) {
  if (!prLeads) return "";
  const leads = (prLeads.leads || []).slice(0, 12);
  const flyovers = (prLeads.flyovers || []).slice(0, 8);
  if (!leads.length && !flyovers.length) return "";
  const list = (items, meta) =>
    items
      .map(
        (l) =>
          `<li><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.title || l.url)}</a>` +
          `<span class="pr-lead-meta">${escapeHtml(meta(l))}</span></li>`
      )
      .join("");
  return `
    <details class="pr-leads" open>
      <summary>PR leads to check <span class="pr-lead-meta">unverified · updated ${escapeHtml((prLeads.updatedAt || "").slice(0, 10))}</span></summary>
      ${leads.length ? `<h5>From web search</h5><ul>${list(leads, (l) => l.query)}</ul>` : ""}
      ${flyovers.length ? `<h5>Past T-6 flyovers (DVIDS)</h5><ul>${list(flyovers, (l) => [l.date, l.unit].filter(Boolean).join(" · "))}</ul>` : ""}
    </details>`;
}

export function renderFeed(container, { visibleEvents, eventsByPlace }, places, onSelect, { prLeads = null } = {}) {
  const placeById = new Map(places.map((p) => [p.id, p]));
  const leadsHtml = prLeadsHtml(prLeads);

  if (visibleEvents.length === 0) {
    container.innerHTML = `
      <h2>Feed</h2>
      <p class="view-sub">Chronological, respecting every filter in the rail.</p>
      ${leadsHtml}
      <div class="empty-state">Nothing matches the current filters. Try widening the range or date window.</div>
    `;
    return;
  }

  // group by weekend (Friday key)
  const groups = new Map();
  for (const ev of visibleEvents) {
    const friday = fridayOf(parseDate(ev.start));
    const key = toDateKey(friday);
    if (!groups.has(key)) groups.set(key, { friday, events: [] });
    groups.get(key).events.push(ev);
  }

  const sortedKeys = Array.from(groups.keys()).sort();

  const html = sortedKeys
    .map((key) => {
      const group = groups.get(key);
      const rows = group.events
        .map((ev) => {
          const place = placeById.get(ev.placeId);
          const badge = ev.confidence !== "confirmed" ? `<span class="badge estimate">est.</span>` : "";
          const favStar = ev.isFavoriteArtist ? `<span class="badge favorite">★</span>` : "";
          const prBadge = ev.pr ? `<span class="badge pr" title="${ev.pr.replace(/"/g, "&quot;")}">PR</span>` : "";
          const label = `${decodeEntities(ev.title)}, ${place ? place.name : ev.placeId}, ${formatDateRange(ev.start, ev.end)}`;
          return `
            <button type="button" class="feed-row" data-event="${ev.id}" data-place="${ev.placeId}" aria-label="${label.replace(/"/g, "&quot;")}">
              <div class="fr-date">${formatDateRange(ev.start, ev.end)}</div>
              <div>
                <div class="fr-title"><span class="scale-dot ${ev.scale}"></span>${decodeEntities(ev.title)}</div>
                <div class="fr-place">${place ? place.name : ev.placeId} · ${place ? formatFlightTime(place.flightMinutes) : ""}</div>
                ${ev.pr ? `<div class="fr-pr">${ev.pr}</div>` : ""}
              </div>
              <div class="fr-meta">
                <span class="badge">${ev.category}</span>
                ${prBadge}${favStar}${badge}
              </div>
            </button>`;
        })
        .join("");
      return `
        <div class="feed-group">
          <h4>Weekend of ${formatDateRange(key, key)}</h4>
          ${rows}
        </div>`;
    })
    .join("");

  container.innerHTML = `
    <h2>Feed</h2>
    <p class="view-sub">Chronological, grouped by weekend, respecting every filter in the rail.</p>
    ${leadsHtml}
    ${html}
  `;

  container.querySelectorAll(".feed-row").forEach((row) => {
    row.addEventListener("click", () => onSelect(row.dataset.place, row.dataset.event));
  });
}
