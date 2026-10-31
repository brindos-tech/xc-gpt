import { addDays, formatDateShort, toDateKey, parseDate } from "../format.js";

const PRESETS = [
  { label: "This weekend", days: 3 },
  { label: "Next 2 weeks", days: 14 },
  { label: "Next 30 days", days: 30 },
  { label: "Next 90 days", days: 90 },
];

// Events-page date range: presets, a From / To pair of calendar boxes, and
// a weekly density histogram that shows where the events are.
export function createScrubber({ store, config, allEvents }) {
  const wrap = document.getElementById("scrubberWrap");
  wrap.innerHTML = `
    <button type="button" class="scrubber-summary" id="scrubberSummary" aria-controls="scrubberBody" aria-expanded="false">
      <span id="scrubberSummaryLabel"></span>
      <span class="scrubber-summary-hint">Change</span>
    </button>
    <div class="scrubber-body" id="scrubberBody">
      <div class="scrubber-top">
        <div class="scrubber-presets" style="display:flex;gap:6px;flex-wrap:wrap;">
          ${PRESETS.map((p, i) => `<button class="chip" data-preset="${i}">${p.label}</button>`).join("")}
        </div>
        <div class="date-range" role="group" aria-label="Date range">
          <label>From <input type="date" id="dateFrom"></label>
          <label>To <input type="date" id="dateTo"></label>
        </div>
      </div>
      <div class="scrubber-track" style="position:relative;height:34px;">
        <canvas id="densityCanvas" style="position:absolute;inset:0;width:100%;height:100%;"></canvas>
      </div>
    </div>
  `;

  const canvas = document.getElementById("densityCanvas");
  const presetRow = wrap.querySelector(".scrubber-presets");
  const dateFrom = document.getElementById("dateFrom");
  const dateTo = document.getElementById("dateTo");
  const summaryBtn = document.getElementById("scrubberSummary");
  const summaryLabel = document.getElementById("scrubberSummaryLabel");

  // On phones this strip eats scarce vertical space that the map wants, and
  // once a range is picked it's reference material rather than a control.
  // Collapse it to a one-line summary; tapping that brings it back. Matches
  // the CSS breakpoint — the collapse rules live inside the same media query.
  const isNarrow = window.matchMedia("(max-width: 860px)");

  function setCollapsed(collapsed) {
    wrap.classList.toggle("collapsed", collapsed);
    summaryBtn.setAttribute("aria-expanded", String(!collapsed));
    // The density canvas measures 0px wide while it's display:none.
    if (!collapsed) {
      requestAnimationFrame(() => {
        const { dateRange } = store.getState();
        drawDensity(dateRange.start, dateRange.end);
      });
    }
  }
  summaryBtn.addEventListener("click", () => setCollapsed(!wrap.classList.contains("collapsed")));

  const today = store.getState().today;
  const horizonStart = addDays(today, -14);

  // weekly density histogram, starting from the widest horizon we'd ever
  // consider (a year out)
  function computeWeeklyDensity(totalDays) {
    const weeks = Math.ceil(totalDays / 7);
    const buckets = new Array(weeks).fill(0);
    for (const ev of allEvents) {
      const d = parseDate(ev.start);
      const offset = Math.round((d - horizonStart) / 86400000);
      const week = Math.floor(offset / 7);
      if (week >= 0 && week < weeks) buckets[week]++;
    }
    return buckets;
  }

  const rawTotalDays = Math.round((addDays(today, 365) - horizonStart) / 86400000);
  const rawBuckets = computeWeeklyDensity(rawTotalDays);

  // Fetched event data thins out hard once the source horizon is
  // exhausted — past that point all that's left is the odd annual-estimate
  // placeholder for next year's recurrence of a handful of festivals, not
  // real browsable coverage. Stop at the first point coverage goes empty for
  // two weeks running, so the calendar can't be pointed into a dead zone.
  const todayWeek = Math.floor((today - horizonStart) / 86400000 / 7);
  let coverageWeeks = rawBuckets.length;
  for (let i = todayWeek; i < rawBuckets.length - 1; i++) {
    if (rawBuckets[i] === 0 && rawBuckets[i + 1] === 0) {
      coverageWeeks = i;
      break;
    }
  }
  const buckets = rawBuckets.slice(0, coverageWeeks);
  const maxBucket = Math.max(1, ...buckets);
  const coverageEnd = addDays(horizonStart, coverageWeeks * 7);

  // the native calendar greys out anything outside these
  dateFrom.min = dateTo.min = toDateKey(today);
  dateFrom.max = dateTo.max = toDateKey(coverageEnd);

  function drawDensity(rangeStart, rangeEnd) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const barW = w / buckets.length;
    const rangeStartOffset = Math.round((rangeStart - horizonStart) / 86400000);
    const rangeEndOffset = Math.round((rangeEnd - horizonStart) / 86400000);

    buckets.forEach((count, i) => {
      const barH = Math.max(2, (count / maxBucket) * (h - 4));
      const weekStartOffset = i * 7;
      const inRange = weekStartOffset + 7 > rangeStartOffset && weekStartOffset < rangeEndOffset;
      ctx.fillStyle = inRange ? "#ff8a3d" : "#2a2f3a";
      ctx.fillRect(i * barW + 0.5, h - barH, Math.max(1, barW - 1), barH);
    });
  }

  function setRange(start, end) {
    store.setState({ dateRange: { start, end } });
  }

  presetRow.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if (!btn) return;
    const preset = PRESETS[Number(btn.dataset.preset)];
    setRange(today, addDays(today, preset.days));
    if (isNarrow.matches) setCollapsed(true);
  });

  // Moving one box never leaves the range backwards: the other box follows.
  dateFrom.addEventListener("change", () => {
    if (!dateFrom.value) return;
    const start = parseDate(dateFrom.value);
    const { end } = store.getState().dateRange;
    setRange(start, end < start ? start : end);
  });
  dateTo.addEventListener("change", () => {
    if (!dateTo.value) return;
    const end = parseDate(dateTo.value);
    const { start } = store.getState().dateRange;
    setRange(start > end ? end : start, end);
  });

  window.addEventListener("resize", () => {
    const s = store.getState();
    drawDensity(s.dateRange.start, s.dateRange.end);
  });

  // The default range counts as chosen already, so on phones start folded
  // away — the summary line still says which range is active.
  setCollapsed(isNarrow.matches);

  // main.js calls this on every state change, which makes it the one place a
  // date range set from outside this strip (a range restored from the URL,
  // a preset) gets reflected back into the inputs and the highlighted preset.
  function redraw(state) {
    const { start, end } = state.dateRange;
    summaryLabel.textContent = `${formatDateShort(start)} – ${formatDateShort(end)}`;
    // Don't overwrite a value the user is mid-way through picking.
    if (document.activeElement !== dateFrom) dateFrom.value = toDateKey(start);
    if (document.activeElement !== dateTo) dateTo.value = toDateKey(end);

    // A preset is only "the" preset when the window also starts today.
    const spanDays = Math.round((end - start) / 86400000);
    const startsToday = toDateKey(start) === toDateKey(today);
    const presetIdx = startsToday ? PRESETS.findIndex((p) => p.days === spanDays) : -1;
    presetRow.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", Number(c.dataset.preset) === presetIdx));
    drawDensity(start, end);
  }

  return { redraw };
}
