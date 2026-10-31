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

// ---- distance from a point to GeoJSON geometry ----

/** Flat nm coordinates around `o` — accurate enough at planning ranges. */
function localNm(o) {
  const k = Math.cos(toRad(o.lat)) * 60;
  return ([lon, lat]) => [(lon - o.lon) * k, (lat - o.lat) * 60];
}

function distToSegment(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len2)) : 0;
  return Math.hypot(a[0] + t * dx, a[1] + t * dy);
}

function ringDistAndInside(ring) {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    d = Math.min(d, distToSegment(ring[j], ring[i]));
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return { d, inside };
}

/**
 * Smallest distance (nm) from `origin` {lat, lon} to a GeoJSON geometry:
 * 0 when the origin is inside a polygon, otherwise the distance to the
 * nearest edge/line. Handles Polygon, MultiPolygon, LineString, MultiLineString
 * and Point. Returns Infinity for anything else.
 */
export function distanceToGeometryNm(geometry, origin) {
  if (!geometry) return Infinity;
  const proj = localNm(origin);
  const line = (coords) => {
    const pts = coords.map(proj);
    let d = pts.length === 1 ? Math.hypot(pts[0][0], pts[0][1]) : Infinity;
    for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSegment(pts[i - 1], pts[i]));
    return d;
  };
  const polygon = (rings) => {
    const outer = ringDistAndInside(rings[0].map(proj));
    if (outer.inside) {
      // inside a hole counts as outside
      for (const hole of rings.slice(1)) if (ringDistAndInside(hole.map(proj)).inside) return Math.min(outer.d, ...rings.slice(1).map((h) => ringDistAndInside(h.map(proj)).d));
      return 0;
    }
    return outer.d;
  };
  const { type, coordinates: c } = geometry;
  if (type === "Point") return Math.hypot(...proj(c));
  if (type === "LineString") return line(c);
  if (type === "MultiLineString") return Math.min(...c.map(line));
  if (type === "Polygon") return polygon(c);
  if (type === "MultiPolygon") return Math.min(...c.map(polygon));
  if (type === "GeometryCollection") return Math.min(...geometry.geometries.map((g) => distanceToGeometryNm(g, origin)));
  return Infinity;
}
