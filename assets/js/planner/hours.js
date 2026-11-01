// The FAA "attendance" text ("MON-FRI 0800-1700", "24/7", "SAT CLSD", …) read
// for one day. Anything this can't read with confidence comes back as
// unknown — the raw text is always shown alongside, so a flag is never the
// only source.
import { tzOffsetMin } from "./sun.js";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const dayIndex = (s) => DAYS.indexOf(s.slice(0, 3));

/** Day-spec like "MON-FRI", "SAT-SUN", "MON-THU", "SAT" or "TUE, THU": does it include weekday `dow` (0 = Sunday)? null = can't tell. */
function dayMatches(spec, dow) {
  const parts = spec.split(/[,/&]|\bAND\b/).map((p) => p.trim()).filter(Boolean);
  let any = false;
  for (const p of parts) {
    const m = /^([A-Z]{3,6})(?:\s*-\s*([A-Z]{3,6}))?$/.exec(p);
    if (!m || dayIndex(m[1]) < 0 || (m[2] && dayIndex(m[2]) < 0)) return null;
    any = true;
    const a = dayIndex(m[1]);
    const b = m[2] ? dayIndex(m[2]) : a;
    for (let i = a; ; i = (i + 1) % 7) {
      if (i === dow) return true;
      if (i === b) break;
    }
  }
  return any ? false : null;
}

function monthMatches(spec, month) {
  const m = /^([A-Z]{3})\s*(?:-|TO)\s*([A-Z]{3})$/.exec(spec.trim());
  if (!m || MONTHS.indexOf(m[1]) < 0 || MONTHS.indexOf(m[2]) < 0) return null;
  const a = MONTHS.indexOf(m[1]);
  const b = MONTHS.indexOf(m[2]);
  return a <= b ? month >= a && month <= b : month >= a || month <= b;
}

/**
 * @param {string} text attendance string
 * @param {string} dayKey "YYYY-MM-DD" (the day at the field)
 * @param {string} tz IANA zone of the field (for Z-suffixed times)
 * @returns {{kind:"always"|"unknown"|"closed"|"open", openMin?:number, closeMin?:number, why?:string}}
 *   open/close are minutes after local midnight; closeMin can exceed 1440 for past-midnight closes.
 */
export function hoursForDay(text, dayKey, tz) {
  const raw = String(text || "").trim().toUpperCase();
  if (!raw) return { kind: "unknown", why: "no hours listed" };
  if (raw === "24/7" || raw === "H24" || raw === "24 HOURS" || raw === "ALL/ALL") return { kind: "always" };
  if (/^(UNATNDD|IREG|SEE REF|SEE REMARK|SEE REF REMARK)/.test(raw) || /\bSR\b|SUNRISE|DAWN|DUSK/.test(raw)) return { kind: "unknown", why: /UNATNDD/.test(raw) ? "unattended" : "irregular / see remarks" };

  const [y, m, d] = dayKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const segments = raw.split(";").map((s) => s.trim()).filter(Boolean);
  let sawDays = false;
  let matched = null;
  for (let seg of segments) {
    // optional leading month range ("APR-OCT", "MAR 1 TO SEP 30" is left to unknown)
    const mm = /^([A-Z]{3}\s*-\s*[A-Z]{3})\s+(.*)$/.exec(seg);
    if (mm && MONTHS.indexOf(mm[1].slice(0, 3)) >= 0) {
      const ok = monthMatches(mm[1], m - 1);
      if (ok === null) return { kind: "unknown", why: "seasonal hours" };
      if (!ok) continue;
      seg = mm[2];
    }
    if (/\b(HOL|HOLS|HOLIDAYS?)\b/.test(seg) && !/\d{4}/.test(seg)) continue;
    // "CLSD SAT, SUN AND HOL." style
    const closedLead = /^CLSD\s+(.*)$/.exec(seg);
    if (closedLead) {
      const dm = dayMatches(closedLead[1].replace(/\bAND HOL.*$|\bHOL.*$/, "").replace(/\.$/, "").trim(), dow);
      if (dm) return { kind: "closed" };
      continue;
    }
    const m2 = /^(?:([A-Z][A-Z\s,/&-]*?)\s+)?(CLSD|\d{4}\s*-\s*\d{4}\s*Z?(?:\+{1,2})?(?:L)?)\s*$/.exec(seg.replace(/\s*-\s*/g, "-").replace(/(\d{4})-(\d{4})/g, "$1-$2"));
    if (!m2) return { kind: "unknown", why: "hours text not understood" };
    const days = m2[1] ? dayMatches(m2[1].trim(), dow) : true;
    if (days === null) return { kind: "unknown", why: "hours text not understood" };
    if (m2[1]) sawDays = true;
    if (!days) continue;
    if (m2[2] === "CLSD") return { kind: "closed" };
    const t = /^(\d{2})(\d{2})-(\d{2})(\d{2})(Z?)/.exec(m2[2].replace(/\s/g, ""));
    if (!t) return { kind: "unknown", why: "hours text not understood" };
    let open = Number(t[1]) * 60 + Number(t[2]);
    let close = Number(t[3]) * 60 + Number(t[4]);
    if (t[5] === "Z") {
      const off = tzOffsetMin(tz, new Date(Date.UTC(y, m - 1, d, 12)));
      open = mod1440(open + off);
      close = mod1440(close + off);
    }
    if (close <= open) close += 1440; // past midnight
    matched = { kind: "open", openMin: open, closeMin: close };
    break;
  }
  if (matched) return matched;
  return sawDays ? { kind: "closed" } : { kind: "unknown", why: "hours text not understood" };
}

const mod1440 = (n) => ((n % 1440) + 1440) % 1440;

export const fmtMin = (min) => {
  const h = Math.floor((min % 1440) / 60);
  const mm = String(min % 60).padStart(2, "0");
  return `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
};
