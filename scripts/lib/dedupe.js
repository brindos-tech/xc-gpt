// Event dedupe per ARCHITECTURE.md §16. Curated, recurring, and Ticketmaster
// records will collide — match when placeId matches, dates overlap within
// ±1 day, and normalized title similarity is high.

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .join(" ");
}

const STOPWORDS = new Set(["the", "and", "for", "with", "featuring", "presents", "tour"]);

function bigrams(str) {
  const set = new Set();
  for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
  return set;
}

/** Sorensen-Dice coefficient over character bigrams of normalized titles. */
export function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let intersection = 0;
  for (const bg of ba) if (bb.has(bg)) intersection++;
  return (2 * intersection) / (ba.size + bb.size || 1);
}

const DAY_MS = 86400000;

/**
 * Days of daylight between two events' date ranges — 0 when they overlap.
 * Ranges, not start dates: a merged record spans every performance folded
 * into it (see mergeEventPair), so the next night of a run has to be
 * measured against where the run currently ends, not where it began.
 */
function gapDays(a, b) {
  const aStart = Date.parse(a.start);
  const aEnd = Date.parse(a.end || a.start);
  const bStart = Date.parse(b.start);
  const bEnd = Date.parse(b.end || b.start);
  return Math.max(0, (bStart - aEnd) / DAY_MS, (aStart - bEnd) / DAY_MS);
}

// Machine feeds whose own listings are each a distinct event (see below).
const TICKETING_FEEDS = new Set(["ticketmaster", "seatgeek"]);

export function isDuplicate(eventA, eventB, { titleThreshold = 0.75, dayTolerance = 1 } = {}) {
  if (eventA.placeId !== eventB.placeId) return false;
  if (gapDays(eventA, eventB) > dayTolerance) return false;
  // Two listings from the same ticketing feed are two separate events unless
  // they carry the same name — fuzzy matching within one source folds
  // "Royals vs. Tigers" into "Royals vs. Twins" the next night. Fuzzy
  // matching is for reconciling *different* sources' spellings of one event.
  if (eventA.source === eventB.source && TICKETING_FEEDS.has(eventA.source)) {
    return normalizeTitle(eventA.title) === normalizeTitle(eventB.title);
  }
  return titleSimilarity(eventA.title, eventB.title) >= titleThreshold;
}

const FIELD_PRECEDENCE = {
  description: ["curated", "recurring", "ticketmaster", "seatgeek"],
  // SeatGeek before Ticketmaster: its scale comes from a real popularity
  // score, Ticketmaster's is "local" for nearly everything
  scale: ["curated", "recurring", "seatgeek", "ticketmaster"],
  attendance: ["curated", "recurring", "ticketmaster", "seatgeek"],
  startTime: ["ticketmaster", "seatgeek", "curated", "recurring"],
  ticketUrl: ["ticketmaster", "seatgeek", "curated", "recurring"],
  url: ["ticketmaster", "seatgeek", "curated", "recurring"],
};

const SOURCE_RANK = { curated: 4, recurring: 3, ticketmaster: 2, seatgeek: 1 };

const CONFIDENCE_RANK = { confirmed: 3, "annual-estimate": 2, unconfirmed: 1 };

/** Merge two duplicate event records field-by-field per precedence table. */
export function mergeEventPair(a, b) {
  const bySource = { [a.source]: a, [b.source]: b };
  const merged = { ...a };

  for (const [field, precedence] of Object.entries(FIELD_PRECEDENCE)) {
    for (const source of precedence) {
      const candidate = bySource[source];
      if (candidate && candidate[field] != null && candidate[field] !== "") {
        merged[field] = candidate[field];
        break;
      }
    }
  }

  // Dates are the union, never one side's: the merged record has to cover
  // every night either side was on. Taking a single side's date turned a
  // three-night run into whichever night happened to be merged last, and
  // shrank a curated three-day festival to the one day Ticketmaster listed.
  merged.start = a.start <= b.start ? a.start : b.start;
  const aEnd = a.end || a.start;
  const bEnd = b.end || b.start;
  merged.end = aEnd >= bEnd ? aEnd : bEnd;

  merged.confidence =
    CONFIDENCE_RANK[a.confidence] >= CONFIDENCE_RANK[b.confidence] ? a.confidence : b.confidence;
  merged.id = a.source === "curated" ? a.id : b.source === "curated" ? b.id : a.id;
  // The merged record is as hand-picked as its most curated half — records
  // are folded in date order, so `a` can easily be the feed's copy.
  merged.source = SOURCE_RANK[b.source] > SOURCE_RANK[a.source] ? b.source : a.source;
  merged.recurringId = a.recurringId || b.recurringId || null;
  merged.artistIds = Array.from(new Set([...(a.artistIds || []), ...(b.artistIds || [])]));
  merged.isFavoriteArtist = a.isFavoriteArtist || b.isFavoriteArtist;

  return merged;
}

/**
 * Dedupe a flat list of events, merging duplicates by precedence.
 * Returns { events, mergeLog } where mergeLog records what was merged
 * (written to meta.dedupe so a wrong match is diagnosable).
 */
export function dedupeEvents(events) {
  const result = [];
  const mergeLog = [];

  // Duplicates only ever share a placeId, so compare within each place
  // rather than all-pairs across ~25k events, and in date order so a run of
  // nightly performances folds together front to back.
  const byPlace = new Map();
  for (const ev of events) {
    if (!byPlace.has(ev.placeId)) byPlace.set(ev.placeId, []);
    byPlace.get(ev.placeId).push(ev);
  }

  for (const group of byPlace.values()) {
    group.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const consumed = new Set();
    for (let i = 0; i < group.length; i++) {
      if (consumed.has(i)) continue;
      let current = group[i];
      for (let j = i + 1; j < group.length; j++) {
        if (consumed.has(j)) continue;
        // sorted by start: once a candidate starts too far past the
        // current range's end, nothing later can overlap it either
        if ((Date.parse(group[j].start) - Date.parse(current.end || current.start)) / DAY_MS > 1) break;
        if (isDuplicate(current, group[j])) {
          mergeLog.push({ kept: current.title, mergedFrom: group[j].title, placeId: current.placeId });
          current = mergeEventPair(current, group[j]);
          consumed.add(j);
        }
      }
      result.push(current);
    }
  }

  return { events: result, mergeLog };
}
