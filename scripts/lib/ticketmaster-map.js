// Ticketmaster classification -> our category enum (see lib/schema.js).
// Kept separate from fetch-ticketmaster.js so it can be unit tested without
// that script's network side effects.

// Keyed by name with punctuation and spacing stripped, because the API
// returns "Arts & Theatre" and an exact-string map keyed "arts&theatre"
// matched none of them: every arts event fell through to "misc" and was
// dropped. That silently cost the entire arts catalogue, so normalise before
// lookup and report anything unmapped rather than discarding it quietly.
export const SEGMENT_CATEGORY = {
  music: "concert",
  sports: "sports",
  artstheatre: "art",
  artstheater: "art", // US spelling, in case the segment is ever renamed
};

// Genre beats segment where the genre names one of our own categories.
// Ticketmaster files rodeos under Sports, and food, fairs and holiday
// events under its Miscellaneous segment — which otherwise maps to nothing.
export const GENRE_CATEGORY = {
  rodeo: "rodeo",
  fooddrink: "food",
  foodanddrink: "food",
  fairsfestivals: "festival",
  fairsandfestivals: "festival",
  holiday: "holiday",
  outdoor: "outdoors",
  outdoors: "outdoors",
};

// Title cues for things no classification captures. Air shows and fly-ins
// matter more to this audience than to Ticketmaster's taxonomy.
const TITLE_CATEGORY = [
  [/\bair\s?shows?\b|\bfly-?in\b|\bballoon (festival|fiesta|race|glow)\b/i, "outdoors"],
  [/\brodeo\b/i, "rodeo"],
  [/\b(bbq|barbecue|chili cook-?off|food (truck|wine) festival|wine festival|beer festival|crawfish festival)\b/i, "food"],
];

export function normalizeName(name) {
  return (name || "").toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * @param {{segment?: string, genre?: string, title?: string}} c
 * @param {Map<string, number>} [unmapped] tallies "segment / genre" pairs
 *   that fell through to "misc", for the fetch script's summary log
 */
export function categorize({ segment, genre, title }, unmapped) {
  for (const [re, category] of TITLE_CATEGORY) if (re.test(title || "")) return category;
  const byGenre = GENRE_CATEGORY[normalizeName(genre)];
  if (byGenre) return byGenre;
  const bySegment = SEGMENT_CATEGORY[normalizeName(segment)];
  if (bySegment) return bySegment;
  if (unmapped) {
    const key = `${segment || "(no segment)"} / ${genre || "(no genre)"}`;
    unmapped.set(key, (unmapped.get(key) || 0) + 1);
  }
  return "misc";
}
