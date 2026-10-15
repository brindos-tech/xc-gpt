// "PR opportunity" tagging: events where military aircraft could plausibly
// be part of the show — an air show that wants static displays, a military
// appreciation game, a stadium that has hosted T-6 flyovers before, a
// patriotic-holiday game with a flyover tradition.
//
// This is a tag, not a category: an air show stays "outdoors" and a game
// stays "sports"; the tag adds a reason string the page shows and filters
// on. It flags *candidates* for a human to follow up — actual participation
// goes through the base's public affairs / aerial events process.

// ---- title cues -----------------------------------------------------------

const AIRSHOW = /\bair\s?shows?\b|\bairsho\b|\bfly-?in\b|\baerospace expo\b|\bairventure\b|\bsun 'n fun\b|\bfleet week\b|\bair (and|&) (sea|water) show\b|\bthunder over\b|\bwings over\b|\bblue angels\b|\b(usaf|air force) thunderbirds\b|\bthunderbirds (air|flyover|demo)/i;

const MILITARY_THEME = /\bmilitary (appreciation|night|day|salute|tribute)\b|\bsalute to (service|the troops|the military|our heroes)\b|\barmed forces\b|\bveterans?'? (day|night|appreciation)\b|\bmemorial day\b|\bhero(es)? (night|appreciation)\b|\bfirst responders?\b|\bcommander-in-chief\b|\barmy[- ]navy\b|\bmilitary bowl\b|\barmed forces bowl\b/i;

// Service-academy teams. Only their football games count — that's where
// flyovers and military pageantry happen; an academy volleyball or
// basketball game is just a game.
const ACADEMY = /\bair force (falcons|academy)\b|\bnavy midshipmen\b|\barmy (black knights|west point)\b/i;

const MARQUEE_FLYOVER = [
  [/\b(nascar|indycar|indianapolis 500|daytona 500|coca-cola 600)\b/i, "Motorsport — pre-race flyover tradition"],
  [/\bsuper bowl\b|\bworld series\b|\ball-star game\b|\bcollege football playoff\b|\bnational championship\b/i, "Marquee game — flyover tradition"],
  [/\b(cotton|sugar|rose|orange|fiesta|peach|citrus|alamo|liberty|independence|texas|gator|holiday|sun|las vegas|music city|first responder|armed forces|military) bowl\b/i, "Bowl game — flyover tradition"],
];

// Indoor sports can still host a recruiting/static presence on a military
// night, but never a flyover — say so, since that changes the ask.
const INDOOR = /basketball|hockey|volleyball|wrestling|nba|nhl|wnba|ncaa_basketball|ncaa_hockey|indoor|arena football|ice/i;
// Open-air sports where a flyover is physically possible.
const OUTDOOR = /football|baseball|softball|soccer|lacrosse|rugby|motorsport|racing|nascar|indycar|auto_racing|golf|rodeo|mlb|nfl|mls|ncaa_football|minor_league_baseball/i;

/** Reason from the title alone (usable at fetch time), or null. */
export function prTitleReason(title) {
  if (!title) return null;
  if (AIRSHOW.test(title)) return "Air show — static display or flyover";
  if (MILITARY_THEME.test(title)) return "Military-themed event";
  return null;
}

// ---- patriotic dates ------------------------------------------------------

function nthWeekday(year, month, weekday, nth) {
  const days = [];
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(year, month - 1, d);
    if (dt.getMonth() !== month - 1) break;
    if (dt.getDay() === weekday) days.push(d);
  }
  return nth > 0 ? days[nth - 1] : days[days.length + nth];
}

const key = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** YYYY-MM-DD -> holiday label, for the windows that carry flyover traditions. */
export function patrioticDates(year) {
  const out = new Map();
  const add = (m, d, label) => {
    const dt = new Date(year, m - 1, d);
    out.set(key(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()), label);
  };
  const memorial = nthWeekday(year, 5, 1, -1);
  for (let i = -2; i <= 0; i++) add(5, memorial + i, "Memorial Day weekend");
  add(5, nthWeekday(year, 5, 6, 3), "Armed Forces Day");
  for (const d of [3, 4, 5]) add(7, d, "Independence Day");
  add(9, 11, "September 11");
  // Veterans Day plus the weekend on or before it
  add(11, 11, "Veterans Day");
  for (let i = 1; i <= 6; i++) {
    const d = new Date(year, 10, 11 - i);
    if (d.getDay() === 0 || d.getDay() === 6) add(11, 11 - i, "Veterans Day weekend");
    if (d.getDay() === 5) break;
  }
  return out;
}

const patrioticCache = new Map();
function patrioticLabel(dateKey) {
  const year = Number(dateKey.slice(0, 4));
  if (!patrioticCache.has(year)) patrioticCache.set(year, patrioticDates(year));
  return patrioticCache.get(year).get(dateKey) || null;
}

// ---- venues with prior flyovers ------------------------------------------

export function normalizeVenue(name) {
  return (name || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

/** pr-venues.json entries -> matcher over a venue name. */
export function buildVenueIndex(venues) {
  const entries = venues.map((v) => ({
    ...v,
    needles: [v.venue, ...(v.aliases || [])].map(normalizeVenue).filter(Boolean),
  }));
  return (venueName) => {
    const hay = normalizeVenue(venueName);
    if (!hay) return null;
    return entries.find((e) => e.needles.some((n) => hay.includes(n))) || null;
  };
}

// ---- the tagger -----------------------------------------------------------

/**
 * @param ev merged event (still carrying venue/subcategory/source)
 * @param opts.venueMatch  venue-name -> pr-venues entry | null
 * @returns reason string, or null
 */
export function prReason(ev, { venueMatch } = {}) {
  if (ev.pr) return ev.pr; // set by a curated overlay
  const byTitle = prTitleReason(ev.title);
  const sportText = `${ev.subcategory || ""} ${ev.title || ""}`;
  const indoor = ev.category === "sports" && INDOOR.test(ev.subcategory || "");
  if (byTitle === "Military-themed event" && ev.category === "sports") {
    return indoor ? "Military appreciation game (indoor — static/recruiting presence, no flyover)" : "Military appreciation game";
  }
  if (byTitle) return byTitle;

  if (ev.category === "sports" && ACADEMY.test(ev.title) && /football/i.test(sportText)) {
    return "Service academy football game";
  }

  if (ev.category === "sports") {
    for (const [re, reason] of MARQUEE_FLYOVER) if (re.test(ev.title)) return reason;
  }

  const outdoorSport = ev.category === "sports" && !indoor && OUTDOOR.test(sportText);
  if (outdoorSport && venueMatch && ev.venue?.name) {
    const hit = venueMatch(ev.venue.name);
    if (hit) return `Venue has hosted military flyovers: ${hit.venue}${hit.note ? ` (${hit.note})` : ""}`;
  }
  if (outdoorSport) {
    for (let d = ev.start; d <= (ev.end || ev.start); d = nextDay(d)) {
      const label = patrioticLabel(d);
      if (label) return `${label} game — flyover tradition`;
    }
  }
  return null;
}

function nextDay(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return key(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
}

// ---- curated overlays -----------------------------------------------------

/**
 * pr-events.json: hand-researched PR opportunities. Each either tags an
 * event already in the feed (same place, overlapping date, title matching
 * `match`) or, when none matches and it carries a title, is added as an
 * event of its own.
 */
export function applyPrOverlays(events, overlays) {
  const added = [];
  let tagged = 0;
  for (const o of overlays) {
    const end = o.end || o.start;
    const re = o.match ? new RegExp(o.match, "i") : null;
    const hits = events.filter(
      (ev) => ev.placeId === o.placeId && ev.start <= end && (ev.end || ev.start) >= o.start && (!re || re.test(ev.title))
    );
    if (hits.length && re) {
      for (const ev of hits) ev.pr = o.reason;
      tagged += hits.length;
    } else if (o.title) {
      added.push({
        id: `pr-${o.id}`,
        title: o.title,
        start: o.start,
        end,
        placeId: o.placeId,
        category: o.category || "sports",
        scale: o.scale || "major",
        confidence: o.confidence || "confirmed",
        url: o.url || "",
        description: o.note || "",
        source: "curated",
        pr: o.reason,
      });
    }
  }
  return { added, tagged };
}
