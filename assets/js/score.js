// Relevance scoring — pure functions, all weights read from config.scoring.
import { isHighlightEvent } from "./importance.js";

// A non-favorite concert or a non-pro/non-SEC sports game contributes
// nothing to a place or weekend's ranking — see importance.js. They can
// still be browsed (subject to filters.js's horizon-based visibility gate)
// but they can never win a "suggested city" slot.
export function eventScore(event, place, scoring) {
  if (!isHighlightEvent(event)) return 0;
  const scaleW = scoring.scaleWeight[event.scale] ?? 1;
  const favMult = event.isFavoriteArtist ? scoring.favoriteArtistMultiplier : 1;
  const distanceNm = place ? place.distanceNm : 0;
  const proximity = Math.pow(2, -distanceNm / scoring.proximityHalfLifeNm);
  const confPenalty = scoring.confidencePenalty[event.confidence] ?? 1;
  const rarity = event.recurringId
    ? scoring.rarityBoost.annual
    : scoring.rarityBoost.recurring;

  return scaleW * favMult * proximity * confPenalty * rarity;
}

// The Boutique activity filter (the "weird" key) is meant for small towns with
// real character — not just any place that clears a nonzero curated score.
// Without a gate here, both big cities that simply don't rate high on
// quirkiness (Dallas, Tulsa, ...) and the bare-minimum military-hometown
// entries (added so nearby recreation is browsable for an assignment, not
// as real getaways — e.g. Altus OK, Radcliff KY) clutter the list. Require
// the "boutique" kind tag plus real texture on at least three activity
// axes, so a place needs more going for it than a flat floor profile (or
// one or two middling scores) to count as worth the trip.
export function isWorthABoutiqueVisit(place) {
  if (!place.kinds?.includes("boutique")) return false;
  const richAxes = Object.values(place.activities || {}).filter((v) => v >= 2).length;
  return richAxes >= 3;
}
