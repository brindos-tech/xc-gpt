// Shared "is this worth counting/showing" logic for concerts and sports.
// Ticketmaster lists everything from stadium tours down to small-college
// club sports with no reliable popularity signal (venue capacity is
// essentially never populated — see the comment on estimateScale in
// scripts/fetch-ticketmaster.js), so "big vs. small" has to be judged from
// the event itself: for concerts, whether it's one of the user's actual
// Spotify artists; for sports, whether either team is a pro franchise or an
// SEC school.
//
// score.js's eventScore reads isHighlightEvent and always requires a
// highlight before an event contributes anything to a place/weekend's
// ranking, so a random non-favorite concert or small-college game can never
// win a "suggested city" slot — but it still shows up for browsing in the
// Feed and elsewhere; the Feed shows everything in range/window and leaves
// narrowing it down to the user's own filters (category, min scale, search).

const PRO_TEAMS = [
  // NFL
  "Arizona Cardinals", "Atlanta Falcons", "Baltimore Ravens", "Buffalo Bills", "Carolina Panthers",
  "Chicago Bears", "Cincinnati Bengals", "Cleveland Browns", "Dallas Cowboys", "Denver Broncos",
  "Detroit Lions", "Green Bay Packers", "Houston Texans", "Indianapolis Colts", "Jacksonville Jaguars",
  "Kansas City Chiefs", "Las Vegas Raiders", "Los Angeles Chargers", "Los Angeles Rams", "Miami Dolphins",
  "Minnesota Vikings", "New England Patriots", "New Orleans Saints", "New York Giants", "New York Jets",
  "Philadelphia Eagles", "Pittsburgh Steelers", "San Francisco 49ers", "Seattle Seahawks",
  "Tampa Bay Buccaneers", "Tennessee Titans", "Washington Commanders",
  // NBA
  "Atlanta Hawks", "Boston Celtics", "Brooklyn Nets", "Charlotte Hornets", "Chicago Bulls",
  "Cleveland Cavaliers", "Dallas Mavericks", "Denver Nuggets", "Detroit Pistons", "Golden State Warriors",
  "Houston Rockets", "Indiana Pacers", "LA Clippers", "Los Angeles Clippers", "Los Angeles Lakers",
  "Memphis Grizzlies", "Miami Heat", "Milwaukee Bucks", "Minnesota Timberwolves", "New Orleans Pelicans",
  "New York Knicks", "Oklahoma City Thunder", "Orlando Magic", "Philadelphia 76ers", "Phoenix Suns",
  "Portland Trail Blazers", "Sacramento Kings", "San Antonio Spurs", "Toronto Raptors", "Utah Jazz",
  "Washington Wizards",
  // MLB
  "Arizona Diamondbacks", "Atlanta Braves", "Baltimore Orioles", "Boston Red Sox", "Chicago Cubs",
  "Chicago White Sox", "Cincinnati Reds", "Cleveland Guardians", "Colorado Rockies", "Detroit Tigers",
  "Houston Astros", "Kansas City Royals", "Los Angeles Angels", "Los Angeles Dodgers", "Miami Marlins",
  "Milwaukee Brewers", "Minnesota Twins", "New York Mets", "New York Yankees", "Athletics",
  "Philadelphia Phillies", "Pittsburgh Pirates", "San Diego Padres", "San Francisco Giants",
  "Seattle Mariners", "St. Louis Cardinals", "Tampa Bay Rays", "Texas Rangers", "Toronto Blue Jays",
  "Washington Nationals",
  // NHL
  "Anaheim Ducks", "Boston Bruins", "Buffalo Sabres", "Calgary Flames", "Carolina Hurricanes",
  "Chicago Blackhawks", "Colorado Avalanche", "Columbus Blue Jackets", "Dallas Stars", "Detroit Red Wings",
  "Edmonton Oilers", "Florida Panthers", "Los Angeles Kings", "Minnesota Wild", "Montreal Canadiens",
  "Nashville Predators", "New Jersey Devils", "New York Islanders", "New York Rangers", "Ottawa Senators",
  "Philadelphia Flyers", "Pittsburgh Penguins", "San Jose Sharks", "Seattle Kraken", "St. Louis Blues",
  "Tampa Bay Lightning", "Toronto Maple Leafs", "Utah Mammoth", "Vancouver Canucks", "Vegas Golden Knights",
  "Washington Capitals", "Winnipeg Jets",
];

// SEC as of the 2024 realignment (16 schools) — matched as full
// "School Nickname" phrases (not bare nicknames like "Tigers" or
// "Bulldogs", which several SEC schools share and which would also
// false-positive on unrelated schools).
const SEC_TEAMS = [
  "Alabama Crimson Tide", "Arkansas Razorbacks", "Auburn Tigers", "Florida Gators", "Georgia Bulldogs",
  "Kentucky Wildcats", "LSU Tigers", "Mississippi State Bulldogs", "Missouri Tigers", "Oklahoma Sooners",
  "Ole Miss Rebels", "Mississippi Rebels", "South Carolina Gamecocks", "Tennessee Volunteers",
  "Tennessee Vols", "Texas Longhorns", "Texas A&M Aggies", "Vanderbilt Commodores",
];

// A few marquee SEC rivalry games get titled by the rivalry's own name
// rather than "School Nickname vs. School Nickname" (e.g. "Red River
// Rivalry: Texas vs. Oklahoma" — no "Longhorns"/"Sooners" in sight), so the
// full-name match above would miss them.
const NAMED_SEC_RIVALRIES = ["Red River Rivalry", "Iron Bowl", "Egg Bowl"];

const IMPORTANT_SPORTS_KEYWORDS = [...PRO_TEAMS, ...SEC_TEAMS, ...NAMED_SEC_RIVALRIES];

export function isProOrSecSportsEvent(title) {
  if (!title) return false;
  return IMPORTANT_SPORTS_KEYWORDS.some((team) => title.includes(team));
}

export function isHighlightEvent(event) {
  // Hand-picked events (curated seed + recurring.json) were chosen because
  // they're worth the flight — a rodeo, a state fair, a marquee festival —
  // so the feed-noise rules below don't apply to them.
  if (event.curated) return true;
  if (event.category === "concert" || event.category === "festival") {
    return !!event.isFavoriteArtist;
  }
  if (event.category === "sports") {
    return isProOrSecSportsEvent(event.title);
  }
  return true; // art/food/outdoors/fair/rodeo/holiday: low volume, always fine
}

