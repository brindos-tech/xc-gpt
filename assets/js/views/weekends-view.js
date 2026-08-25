import { addDays, formatDateRange, formatFlightTime, toDateKey, decodeEntities, fridayOf, parseDate } from "../format.js";
import { rankWeekendCandidates } from "../score.js";

export function renderWeekends(container, filtered, { places, config, overrides }, onSelect) {
  const { visibleEvents, dateRangeStart, dateRangeEnd } = filtered;
  const state = filtered.state;
  const placeById = new Map(places.map((p) => [p.id, p]));

  // find all Fridays within the date window
  const fridays = [];
  let cursor = fridayOf(state.dateRange.start);
  if (cursor < state.dateRange.start) cursor = addDays(cursor, 7);
  while (cursor <= state.dateRange.end) {
    fridays.push(new Date(cursor));
    cursor = addDays(cursor, 7);
  }

  if (fridays.length === 0) {
    container.innerHTML = `
      <h2>Weekend Recs</h2>
      <p class="view-sub">Derived from the events currently in view — widen the date window to see weekends.</p>
      <div class="empty-state">No full weekend falls inside the current date window.</div>
    `;
    return;
  }

  const cardsHtml = fridays
    .map((friday) => {
      const sunday = addDays(friday, 2);
      const weekendEvents = visibleEvents.filter((ev) => {
        const evStart = new Date(ev.start);
        return evStart >= addDays(friday, -0) && evStart <= addDays(sunday, 1);
      });

      // override dates are keyed by the event's own start date (often the
      // Saturday), so match anything falling within this Fri-Sun span
      // rather than requiring an exact Friday-key match.
      const override = Object.entries(overrides).find(([dateKey]) => {
        const d = parseDate(dateKey);
        return d >= friday && d <= sunday;
      })?.[1];
      const candidates = rankWeekendCandidates(friday, weekendEvents, places, config.scoring, override, state.rangeNm);

      if (candidates.length === 0) {
        return `
          <div class="weekend-card">
            <div class="wk-header"><span class="wk-date">${formatDateRange(toDateKey(friday), toDateKey(sunday))}</span></div>
            <div class="wk-event" style="color:var(--muted)">Nothing scored in range this weekend — open territory for a fun flight.</div>
          </div>`;
      }

      const [primary, ...backups] = candidates;
      const topEvents = primary.events.slice(0, 2).map((e) => decodeEntities(e.title)).join(" + ");

      const backupsHtml = backups.length
        ? `<div class="wk-backups">${backups
            .map(
              (b, i) =>
                `<div class="wk-backup-row"><span class="badge backup">Backup ${i + 1}</span> <b>${b.place.name}</b> — ${b.events
                  .slice(0, 1)
                  .map((e) => decodeEntities(e.title))
                  .join("")} · ${formatFlightTime(b.place.flightMinutes)}</div>`
            )
            .join("")}</div>`
        : "";

      const weekendLabel = `${primary.place.name}, ${formatDateRange(toDateKey(friday), toDateKey(sunday))}${topEvents ? `, ${topEvents}` : ""}`;
      return `
        <button type="button" class="weekend-card" data-place="${primary.place.id}" aria-label="${weekendLabel.replace(/"/g, "&quot;")}">
          <div class="wk-header">
            <span class="wk-date">${formatDateRange(toDateKey(friday), toDateKey(sunday))}</span>
            <span class="badge best-match">Best Match</span>
          </div>
          <div class="wk-primary">
            <span class="wk-city">${primary.place.name}</span>
            <span style="color:var(--accent2);font-size:0.85em;">${formatFlightTime(primary.place.flightMinutes)}</span>
          </div>
          <div class="wk-event">${topEvents || (primary.note || "")}</div>
          ${backupsHtml}
        </button>`;
    })
    .join("");

  container.innerHTML = `
    <h2>Weekend Recs</h2>
    <p class="view-sub">One best-match pick plus up to two backups, ranked automatically from events in view.</p>
    <div class="weekend-list">${cardsHtml}</div>
  `;

  container.querySelectorAll(".weekend-card[data-place]").forEach((card) => {
    card.addEventListener("click", () => onSelect(card.dataset.place));
  });
}
