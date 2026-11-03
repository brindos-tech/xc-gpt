// The events data (places, events, weather outlook), loaded once and shared by
// the Events map and the Weekend Recs page. The event file is the biggest
// download on the site, so nothing loads it until one of those pages opens.
let promise = null;

export function loadEventsData(loadJson) {
  promise ??= Promise.all([
    loadJson("curated/places.json"),
    loadJson("generated/events.json").catch(() => loadJson("curated/events.seed.json")),
    loadJson("generated/weather.json").catch(() => ({})),
  ]).then(([places, events, weather]) => ({ places, events, weather }));
  // a failed load shouldn't be cached forever
  promise.catch(() => (promise = null));
  return promise;
}
