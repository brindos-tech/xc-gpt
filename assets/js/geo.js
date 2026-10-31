// Shared geo math. Dependency-free ES module — imported by both the browser
// runtime and the Node build scripts. Do not add DOM or Node globals here.

const EARTH_RADIUS_NM = 3440.065;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in nautical miles between two {lat, lon} points. */
export function greatCircleNm(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_NM * c;
}

/** Flight time in minutes for a given distance and cruise speed (knots). */
export function flightMinutes(nm, cruiseKts) {
  return (nm / cruiseKts) * 60;
}

/** Number of legs required given a per-leg range. */
export function legsRequired(nm, legRangeNm) {
  return Math.max(1, Math.ceil(nm / legRangeNm));
}

/**
 * Plan a route from origin to dest, inserting a fuel stop from
 * `candidateFields` if the direct leg exceeds legRangeNm - reserveNm.
 * candidateFields: array of {icao, lat, lon, vanceApproved}
 * Returns null if no feasible single-stop route exists.
 */
export function planRoute(origin, dest, candidateFields, legRangeNm, reserveNm = 50) {
  const directNm = greatCircleNm(origin, dest);
  const usableRange = legRangeNm - reserveNm;

  if (directNm <= usableRange) {
    return {
      legs: [{ from: "origin", to: "dest", nm: directNm, minutes: null }],
      totalNm: directNm,
      stops: [],
      feasible: true,
    };
  }

  const approved = (candidateFields || []).filter((f) => f.vanceApproved);
  let best = null;
  let bestDelta = Infinity;

  for (const field of approved) {
    const leg1 = greatCircleNm(origin, field);
    const leg2 = greatCircleNm(field, dest);
    if (leg1 > usableRange || leg2 > usableRange) continue;
    const delta = Math.abs(leg1 - leg2);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = { field, leg1, leg2 };
    }
  }

  if (!best) {
    return {
      legs: [{ from: "origin", to: "dest", nm: directNm, minutes: null }],
      totalNm: directNm,
      stops: [],
      feasible: false,
    };
  }

  return {
    legs: [
      { from: "origin", to: best.field.icao, nm: best.leg1, minutes: null },
      { from: best.field.icao, to: "dest", nm: best.leg2, minutes: null },
    ],
    totalNm: best.leg1 + best.leg2,
    stops: [best.field.icao],
    feasible: true,
  };
}
