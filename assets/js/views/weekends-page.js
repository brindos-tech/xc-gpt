// The Weekend Recs tab: for each upcoming Fri–Sun, the best pick within range
// plus two backups, mixed across sports, concerts and other big events (see
// weekends.js). Uses the base and range from the rail; the header search narrows
// the events considered.
import { esc } from "../planner/html.js";
import { loadEventsData } from "../events/data.js";
import { greatCircleNm, flightMinutes } from "../geo.js";
import { addDays, decodeEntities, formatFlightTime, parseDate, toDateKey } from "../format.js";
import { outlookForDays } from "../weather.js";
import { planWeekends, upcomingWeekends, GROUP_LABELS, GROUPS } from "../weekends.js";

const FIRST_COUNT = 12;
const MORE = 8;
const MAX_COUNT = 40;

const md = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const mdw = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function eventWhen(ev, week) {
  const start = parseDate(ev.start);
  const end = parseDate(ev.end || ev.start);
  if (+start === +end) return mdw(start);
  if (start < week.friday) return `through ${md(end)}`;
  return `${md(start)} – ${md(end)}`;
}

function weatherHtml(weather, friday) {
  const days = outlookForDays(weather, [0, 1, 2].map((n) => toDateKey(addDays(friday, n))));
  if (!days.length) return "";
  return `<div class="wk-wx" aria-label="Weather outlook for that weekend">${days
    .map((d) => `<span class="wk-wx-day${d.icing || d.thunder ? " wk-wx-warn" : ""}" title="${esc(d.label)}, low ${d.lo}°, ${d.precip}% precip">${esc(d.dow)} ${d.hi}° · ${d.precip}% precip${d.icing ? " · icing?" : d.thunder ? " · storms" : ""}</span>`)
    .join("")}</div>`;
}

export function createWeekendsPage({ root, store, config, loadJson, today }) {
  let data = null;
  let status = "idle"; // idle | loading | error
  let count = FIRST_COUNT;
  let memo = { key: "", plan: null };
  const originsById = new Map(config.origins.map((o) => [o.id, o]));

  async function load() {
    if (data || status === "loading") return;
    status = "loading";
    paint(store.getState());
    try {
      data = await loadEventsData(loadJson);
      status = "idle";
    } catch {
      status = "error";
    }
    paint(store.getState());
  }

  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-wk-more]")) {
      count = Math.min(MAX_COUNT, count + MORE);
      return paint(store.getState());
    }
    const open = e.target.closest("[data-wk-open]");
    if (open) {
      const friday = parseDate(open.dataset.wkWeek);
      store.setState({ view: "events", selectedPlaceId: open.dataset.wkOpen, dateRange: { start: friday, end: addDays(friday, 2) } });
    }
  });

  function planFor(state) {
    const origin = originsById.get(state.originId);
    const q = (state.search || "").trim().toLowerCase();
    const key = `${state.originId}|${state.rangeNm}|${count}|${q}`;
    if (memo.key === key) return memo.plan;
    const places = data.places.map((p) => {
      const distanceNm = greatCircleNm(origin, p);
      return { ...p, distanceNm, flightMinutes: flightMinutes(distanceNm, config.aircraft.cruiseKts) };
    });
    const byId = new Map(places.map((p) => [p.id, p]));
    const events = q ? data.events.filter((ev) => `${ev.title} ${ev.category} ${byId.get(ev.placeId)?.name || ""}`.toLowerCase().includes(q)) : data.events;
    const plan = planWeekends({ weekends: upcomingWeekends(today, count), events, places, scoring: config.scoring, rangeNm: state.rangeNm });
    memo = { key, plan };
    return plan;
  }

  const badge = (group) => `<span class="badge wk-kind wk-${group}">${GROUP_LABELS[group]}</span>`;

  function pickHtml(c, week, primary) {
    const title = decodeEntities(c.event.title);
    const more = c.more.length ? `<span class="muted small"> · +${c.more.length} more there</span>` : "";
    const link = c.event.url ? `<a href="${esc(c.event.url)}" target="_blank" rel="noopener noreferrer">${esc(title)} ↗</a>` : esc(title);
    return `<div class="${primary ? "wk-primary" : "wk-backup"}">
      <div class="wk-line">${primary ? `<span class="badge best-match">Best match</span>` : ""}${badge(c.group)}<b class="wk-title">${link}</b></div>
      <div class="wk-place"><span class="wk-city">${esc(c.place.name)}${c.place.state ? `, ${esc(c.place.state)}` : ""}</span> <span class="wk-fly">${esc(formatFlightTime(c.place.flightMinutes))} · ${Math.round(c.place.distanceNm)} nm</span> <span class="muted small">${esc(eventWhen(c.event, week))}</span>${more}</div>
      ${primary ? weatherHtml(data.weather?.[c.place.id], week.friday) : ""}
      <div><button type="button" class="cm-link small" data-wk-open="${esc(c.place.id)}" data-wk-week="${toDateKey(week.friday)}">See ${esc(c.place.name)} on the events map</button></div>
    </div>`;
  }

  function cardHtml(row) {
    const header = `${md(row.friday)} – ${md(row.sunday)}`;
    if (!row.primary) return `<article class="wk-card"><div class="wk-head">${esc(header)}</div><div class="muted">Nothing big in range this weekend — open territory for a fun flight.</div></article>`;
    return `<article class="wk-card">
      <div class="wk-head">${esc(header)}</div>
      ${pickHtml(row.primary, row, true)}
      ${row.backups.length ? `<div class="wk-backups">${row.backups.map((b, i) => `<div class="wk-backup-row"><span class="badge backup">Backup ${i + 1}</span>${pickHtml(b, row, false)}</div>`).join("")}</div>` : ""}
    </article>`;
  }

  function paint(state) {
    const origin = originsById.get(state.originId);
    const head = `<div class="rv-head"><h2>Weekend Recs</h2><span class="muted small">best pick within ${state.rangeNm} nm of ${esc(origin.icao)}, plus two backups</span></div>`;
    let body;
    if (status === "loading" && !data) body = `<p class="muted">Loading events…</p>`;
    else if (status === "error" && !data) body = `<p class="muted">Couldn't load the events data. <button type="button" class="cm-link" data-wk-retry>Retry</button></p>`;
    else if (!data) body = "";
    else {
      const plan = planFor(state);
      const mix = GROUPS.map((g) => `${plan.mix[g]} ${g === "sports" ? "sports" : g === "concert" ? `concert${plan.mix[g] === 1 ? "" : "s"}` : "big event" + (plan.mix[g] === 1 ? "" : "s")}`).join(" · ");
      body = `<p class="muted small">Picks are mixed on purpose so they aren't all one kind: ${esc(mix)}. Change the base or range in the left column${state.search ? `; filtered to “${esc(state.search)}”` : ""}.</p>
        <div class="wk-list">${plan.rows.map(cardHtml).join("")}</div>
        ${count < MAX_COUNT ? `<p><button type="button" class="chip" data-wk-more>Show ${MORE} more weekends</button></p>` : ""}`;
    }
    root.innerHTML = head + body;
  }

  root.addEventListener("click", (e) => e.target.closest("[data-wk-retry]") && ((status = "idle"), load()));

  return {
    render(state) {
      load();
      paint(state);
    },
  };
}
