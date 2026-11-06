// Reads NOTAMs out of the AIXM 5.1 messages the NOTAM Management Service (NMS) API sends: the "initial load"
// file (a gzip of one SOAP/WFS FeatureCollection holding every active NOTAM) and the filtered /notams answers.
// Each NOTAM is one <aixm:member> whose <event:NOTAM> carries the number, location, effective dates and text.
// Plain string scanning, not a DOM: the initial load is tens of megabytes.

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, dec, hex) => (dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ENTITIES[m.toLowerCase()] || m));

/** The text of the first <prefix:name …>…</prefix:name> in `xml` (any prefix), or "". */
function tag(xml, name) {
  const m = new RegExp(`<(?:[A-Za-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?${name}>`).exec(xml);
  return m ? decode(m[1].trim()) : "";
}

/**
 * One <aixm:member> (or any chunk holding one <event:NOTAM>) -> a NOTAM, or null when it holds none.
 * @returns {{id:string, number:string, location:string, icao:string, text:string, start:string, end:string, schedule:string, type:string, classification:string}|null}
 */
export function parseNotamMember(xml) {
  const body = /<(?:[A-Za-z0-9]+:)?NOTAM[\s>][\s\S]*?<\/(?:[A-Za-z0-9]+:)?NOTAM>/.exec(xml)?.[0];
  if (!body) return null;
  const simple = tag(body, "simpleText"); // "!STL 08/430 8WC RWY 20 RWY END ID LGT U/S 2508210234-2510012359"
  const num = /^!\S+\s+(\d{1,2}\/\d{1,5})\s/.exec(simple)?.[1] || "";
  return {
    id: `${tag(body, "year")}-${tag(body, "number")}-${tag(body, "location")}`,
    number: num || [tag(body, "number")].filter(Boolean).join(""),
    location: tag(body, "location"),
    icao: tag(xml, "icaoLocation"),
    text: tag(body, "text").replace(/\s+/g, " ").replace(/^!\S+\s+\d{1,2}\/\d{1,5}\s+\S+\s+/, ""),
    start: tag(body, "effectiveStart"),
    end: tag(body, "effectiveEnd"),
    schedule: tag(body, "schedule"),
    type: tag(body, "type") && /^[NRC]$/.test(tag(body, "type")) ? tag(body, "type") : "",
    classification: tag(xml, "classification"),
  };
}

/**
 * Every NOTAM in a (possibly huge) stream of text chunks, one at a time. Each NOTAM travels in its own
 * <AIXMBasicMessage> (inside <aixm:member> in the sample file, <wfs:member> in the live one), so that is the cut point.
 */
export async function* notamsFromChunks(chunks) {
  const CLOSE = "</AIXMBasicMessage>";
  let buf = "";
  for await (const chunk of chunks) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    // only the new text (plus a possible half-seen closing tag) needs scanning
    const from = Math.max(0, buf.length - CLOSE.length);
    buf += text;
    let at;
    let scan = from;
    while ((at = buf.indexOf(CLOSE, scan)) >= 0) {
      const n = parseNotamMember(buf.slice(0, at + CLOSE.length));
      buf = buf.slice(at + CLOSE.length);
      scan = 0;
      if (n) yield n;
    }
    if (buf.length > 5e7) buf = buf.slice(-1e6); // never grow without bound on a stream with no messages in it
  }
}

/** The /notams?location= answer: JSON {data:{aixm:["<AIXMBasicMessage…", …]}} (or plain AIXM text) -> NOTAMs. */
export async function notamsFromAnswer(body) {
  let parts = [body];
  if (/^\s*[{[]/.test(body)) {
    const json = JSON.parse(body);
    const aixm = json?.data?.aixm ?? json?.aixm ?? [];
    parts = Array.isArray(aixm) ? aixm : [aixm];
  }
  const out = [];
  for (const part of parts) for await (const n of notamsFromChunks([String(part)])) out.push(n);
  return out;
}

/**
 * NOTAM locations (FAA ids like "OKC", ICAO ids like "KOKC") -> our field codes.
 * @param {string[]} codes our field codes ("KOKC", "K79J", "1R8")
 * @param {Object<string,{faaId?:string}>} facts per-field facts (for the FAA id)
 */
export function buildLocationIndex(codes, facts = {}) {
  const byLocation = new Map();
  for (const code of codes) {
    byLocation.set(code, code);
    if (facts[code]?.faaId) byLocation.set(facts[code].faaId, code);
    if (/^K[A-Z0-9]{3}$/.test(code)) byLocation.set(code.slice(1), code);
  }
  return byLocation;
}

/** Which of our field codes a NOTAM belongs to (by its ICAO or FAA location), or null. */
export const fieldCodeFor = (n, byLocation) => byLocation.get(n.icao) || byLocation.get(n.location) || null;
