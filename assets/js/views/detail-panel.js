import { formatFlightTime, formatDateRange, decodeEntities, weatherCodeLabel, dowShort, parseDate } from "../format.js";
import { eventScore } from "../score.js";
import { ICING_TEMP_F, ICING_PRECIP_PCT } from "../weather.js";

// The panel is a quick-glance summary, not the full agenda — cap it to the
// best few events (see importance.js for what "best" means) and point
// anything past that at the Feed instead, rather than dumping every event
// in the window at a busy place.
const HIGHLIGHT_CAP = 5;


// `military` and `pprRequired` are separate facts and have to be read
// separately: a joint-use field like KSPS is military *and* has an open
// civilian ramp, so collapsing the two into a flat "military, PPR" would
// tell a pilot to arrange prior permission they don't actually need.
function airportAccessNote(airport) {
  if (!airport.military) return "";
  return airport.pprRequired ? " — military, PPR required" : " — joint civil-military";
}

function buildWeatherSection(weather) {
  if (!weather || !weather.dates || weather.dates.length === 0) return "";

  const days = weather.dates.slice(0, 6).map((date, i) => ({
    date,
    hi: Math.round(weather.tempMax[i]),
    lo: Math.round(weather.tempMin[i]),
    precip: weather.precipProbability[i],
    label: weatherCodeLabel(weather.weatherCode[i]),
    icing: weather.tempMin[i] <= ICING_TEMP_F && weather.precipProbability[i] >= ICING_PRECIP_PCT,
  }));

  const icingDay = days.find((d) => d.icing);
  const icingBanner = icingDay
    ? `<div class="dp-icing-warn">Possible icing setup ${dowShort(icingDay.date)} (low ${icingDay.lo}°F, ${icingDay.precip}% precip) — verify current conditions before filing.</div>`
    : "";

  const daysHtml = days
    .map(
      (d) => `<div class="dp-wx-day">
        <div class="dp-wx-dow">${dowShort(d.date)}</div>
        <div class="dp-wx-temp">${d.hi}°<span>/${d.lo}°</span></div>
        <div class="dp-wx-precip">${d.precip}%</div>
        <div class="dp-wx-label">${d.label}</div>
      </div>`
    )
    .join("");

  return `
    <h5>16-Day Outlook</h5>
    ${icingBanner}
    <div class="dp-wx-strip">${daysHtml}</div>
    <div class="dp-wx-note">Advisory only — not a substitute for a real weather briefing.</div>
  `;
}

export function createDetailPanel({ store, meta, config }) {
  const linkHealth = meta?.linkHealth ?? {};
  const panel = document.getElementById("detailPanel");
  const content = document.getElementById("detailContent");
  const closeBtn = document.getElementById("detailClose");
  const backdrop = document.getElementById("detailBackdrop");

  // Single place that flips the sheet's visibility, so the backdrop can
  // never be left showing over a closed panel (render() closes it from two
  // separate branches).
  function setPanelOpen(open) {
    panel.classList.toggle("open", open);
    backdrop.classList.toggle("open", open);
  }

  // Every view (including the map's pins) fully redraws its DOM on each
  // state change, so a raw element reference goes stale the instant
  // store.setState below triggers that redraw — .focus() on it would fire
  // just before the element is destroyed. main.js captures *what* was
  // focused (its place id) before that redraw happens and passes it into
  // render() below; re-resolve a live element with the same id after the
  // redraw completes (deferred via setTimeout, not rAF — same reasoning as
  // url-state.js: rAF can be suspended in a backgrounded tab), falling back
  // to the active tab if that place no longer has a visible element.
  let lastFocusedPlaceId = null;

  function closePanel() {
    setPanelOpen(false);
    store.setState({ selectedPlaceId: null, selectedEventId: null });
    const placeId = lastFocusedPlaceId;
    setTimeout(() => {
      const revived = placeId && document.querySelector(`[data-place="${placeId}"]`);
      if (revived) {
        revived.focus();
      } else {
        document.querySelector(".tab-bar button.active")?.focus();
      }
    }, 0);
  }

  closeBtn.addEventListener("click", closePanel);
  backdrop.addEventListener("click", closePanel);

  // Document-level, not panel-level: as a bottom sheet nothing inside it is
  // necessarily focused, and a keydown listener on the panel only fires
  // when focus is already within it.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) closePanel();
  });

  function render(place, eventsForPlace, weather, focusOriginPlaceId) {
    if (!place) {
      setPanelOpen(false);
      return;
    }
    const isNewlyOpening = !panel.classList.contains("open");
    if (isNewlyOpening) lastFocusedPlaceId = focusOriginPlaceId ?? null;
    const airportsHtml = place.airports
      .map(
        (a) =>
          `<div class="dp-airport">${a.icao} ${a.name}${airportAccessNote(a)}${a.driveMiles ? ` · ${a.driveMiles}mi / ${a.driveMinutes}min drive` : ""}</div>`
      )
      .join("");

    // best-scoring first, then take the top N and put those back in
    // chronological order — reads like a normal agenda, just trimmed to
    // the highlights instead of every event at a busy place.
    const highlights = eventsForPlace
      .slice()
      .sort((a, b) => eventScore(b, place, config.scoring) - eventScore(a, place, config.scoring))
      .slice(0, HIGHLIGHT_CAP)
      .sort((a, b) => parseDate(a.start) - parseDate(b.start));
    const overflowCount = eventsForPlace.length - highlights.length;

    const eventsHtml = highlights.length
      ? highlights
          .map((ev) => {
            const badge = ev.confidence !== "confirmed" ? `<span class="badge estimate">est.</span>` : "";
            const fav = ev.isFavoriteArtist ? `<span class="badge favorite">★</span>` : "";
            const linkUrl = ev.url || ev.ticketUrl;
            const flagged = linkUrl && linkHealth[linkUrl];
            const link = linkUrl
              ? flagged
                ? `<span class="badge broken-link" title="This link looked dead the last time we checked (${flagged.status ?? "network error"}).">link may be dead</span>`
                : `<a class="dp-event-link" href="${linkUrl}" target="_blank" rel="noopener noreferrer">event page ↗</a>`
              : "";
            return `<div class="dp-event-row"><b>${formatDateRange(ev.start, ev.end)}</b> — ${decodeEntities(ev.title)} ${fav}${badge} ${link}</div>`;
          })
          .join("")
      : `<div class="dp-event-row" style="color:var(--muted)">No events in the current window.</div>`;
    const moreNoteHtml =
      overflowCount > 0
        ? `<div class="dp-more-note">+${overflowCount} more in this window — showing top picks only.</div>`
        : "";

    content.innerHTML = `
      <h3>${place.name}${place.state ? `, ${place.state}` : ""}</h3>
      <div class="dp-dist">${formatFlightTime(place.flightMinutes)} · ${Math.round(place.distanceNm)} nm${place.route && !place.route.feasible ? " · no feasible fuel stop found" : place.legs > 1 ? ` · ${place.legs} legs` : ""}</div>
      <div class="dp-blurb">${decodeEntities(place.blurb)}</div>
      ${airportsHtml}
      <div class="dp-events">
        <h5>Events in window</h5>
        ${eventsHtml}
        ${moreNoteHtml}
      </div>
      <div class="dp-weather">
        ${buildWeatherSection(weather)}
      </div>
    `;
    setPanelOpen(true);
    if (isNewlyOpening) {
      // move focus into the panel so keyboard/screen-reader users land
      // somewhere sensible, matching the standard dialog-open pattern.
      closeBtn.focus();
    }
  }

  return { render, close: closePanel };
}
