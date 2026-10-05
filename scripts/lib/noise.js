// Ticketmaster lists the things sold *around* an event as events of their
// own — parking passes, suite rentals, hotel bundles, VIP upgrades. They
// carry the real event's name and date, so they show up as clones of it
// in the feed and pad a place's event count. None of them is a reason to
// fly somewhere; drop them before merge.
//
// Patterns are deliberately narrow: "Suite" alone would also catch
// "The Nutcracker Suite", and "Hotel" alone catches "Hotel California"
// tribute acts and "Halloween Hotel Takeover" parties.
const ADD_ON_PATTERNS = [
  /\bparking\b/i,
  /\bsuites?\s+(reservation|rental|package|seat|access|ticket)s?\b/i,
  /(^|\s[-–|:]\s*)(luxury\s+|private\s+)?suites?\s*$/i,
  /\bhotel\s+packages?\b/i,
  /\+\s*hotel\b/i,
  /\bvip\s+(upgrade|package|tailgate|lounge)s?\b/i,
  /\bupgrades?\s*$/i,
  /\bearly entry\b/i,
  /\bpremium seating\b/i,
  /\b(club|lounge)\s+access\b/i,
  /\bseason tickets?\b/i,
  /\bnotification list\b/i,
  /\bwait\s?list\b/i,
  /\bgift cards?\b/i,
  /\bshuttle\b/i,
];

export function isAddOnListing(title) {
  return ADD_ON_PATTERNS.some((re) => re.test(title || ""));
}
