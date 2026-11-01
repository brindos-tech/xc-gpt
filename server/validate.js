// Validation and cleaning of a posted comment. Pure — no I/O.

export const LIMITS = { name: 40, fees: 200, planespotters: 300, amenities: 300, notes: 1500 };
const TRI = new Set(["", "yes", "no"]);
const LINK = /https?:\/\/|www\./i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export const SUBJECT_RE = /^(?:field:[A-Z0-9]{2,5}|airspace:[ -~]{1,90})$/;

const clean = (v, max, { multiline = false } = {}) => {
  let s = String(v ?? "").replace(CONTROL, "").replace(/\r\n?/g, "\n");
  if (!multiline) s = s.replace(/\s+/g, " ");
  else s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim().slice(0, max);
};

/**
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 * `value` has only the public fields (no id/createdAt — the server adds those).
 */
export function validateComment(body, now = new Date()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Send a JSON object." };
  const subject = String(body.subject ?? "");
  if (!SUBJECT_RE.test(subject)) return { ok: false, error: "Unknown subject." };

  const isField = subject.startsWith("field:");
  // "report" = a correction or problem report for the owner; never shown publicly
  const kind = body.kind === "report" ? "report" : "comment";
  const v = {
    subject,
    kind,
    name: clean(body.name, LIMITS.name) || "Anonymous",
    rating: null,
    freeFood: "",
    crewCar: "",
    aircard: "",
    fees: "",
    planespotters: "",
    amenities: "",
    visited: "",
    notes: clean(body.notes, LIMITS.notes, { multiline: true }),
  };

  if (body.rating !== undefined && body.rating !== null && body.rating !== "") {
    const r = Number(body.rating);
    if (!Number.isInteger(r) || r < 1 || r > 5) return { ok: false, error: "Rating must be 1 to 5." };
    v.rating = r;
  }
  for (const key of ["freeFood", "crewCar", "aircard"]) {
    const t = String(body[key] ?? "");
    if (!TRI.has(t)) return { ok: false, error: `Bad value for ${key}.` };
    if (isField) v[key] = t; // these only make sense for a field
  }
  if (isField) {
    v.fees = clean(body.fees, LIMITS.fees);
    v.planespotters = clean(body.planespotters, LIMITS.planespotters);
    v.amenities = clean(body.amenities, LIMITS.amenities);
  }

  if (body.visited) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(body.visited));
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!m || d.getUTCMonth() !== +m[2] - 1) return { ok: false, error: "Date visited must be a real date (YYYY-MM-DD)." };
    const day = 86400000;
    if (d.getTime() > now.getTime() + day) return { ok: false, error: "Date visited can't be in the future." };
    if (d.getTime() < now.getTime() - 5 * 365 * day) return { ok: false, error: "Date visited is too old." };
    v.visited = String(body.visited);
  }

  for (const key of ["name", "fees", "planespotters", "amenities", "notes"]) {
    if (LINK.test(v[key])) return { ok: false, error: "Links aren't allowed in comments." };
  }
  if (kind === "report") {
    // a report is just words: no ratings or field answers ride along
    v.rating = null;
    v.freeFood = v.crewCar = v.aircard = "";
    v.fees = v.planespotters = v.amenities = "";
    if (v.notes.length < 10) return { ok: false, error: "Tell us what's wrong (a sentence or two)." };
  }
  const hasContent = v.rating || v.notes || v.fees || v.planespotters || v.amenities || v.freeFood || v.crewCar || v.aircard;
  if (!hasContent) return { ok: false, error: "Add a rating or a note first." };
  return { ok: true, value: v };
}
