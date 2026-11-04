#!/usr/bin/env node
// One-off probe: which public (no login) FAA NOTAM pages answer from GitHub
// Actions, and what their output looks like. Prints status + the start of
// each body; writes nothing.
//
//   node scripts/probe-notams.js

const UA = "xc-gpt-notam-probe";
const TARGETS = {
  "DINS raw, one field": "https://www.notams.faa.gov/dinsQueryWeb/queryRetrievalMapAction.do?reportType=Raw&retrieveLocId=KOKC&actionType=notamRetrievalByICAOs&submit=View+NOTAMs",
  "DINS raw, three fields": "https://www.notams.faa.gov/dinsQueryWeb/queryRetrievalMapAction.do?reportType=Raw&retrieveLocId=KOKC+KPNC+KTUL&actionType=notamRetrievalByICAOs&submit=View+NOTAMs",
  "PilotWeb raw": "https://pilotweb.nas.faa.gov/PilotWeb/notamRetrievalByICAOAction.do?method=displayByICAOs&reportType=RAW&formatType=DOMESTIC&retrieveLocId=KOKC&actionType=notamRetrievalByICAOs",
};

for (const [name, url] of Object.entries(TARGETS)) {
  console.log(`\n===== ${name}`);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,*/*" }, signal: AbortSignal.timeout(30000) });
    const body = await res.text();
    console.log(`HTTP ${res.status} · ${res.headers.get("content-type")} · ${body.length} bytes · has "!OKC": ${body.includes("!OKC")} · has "!PNC": ${body.includes("!PNC")}`);
    const i = Math.max(0, body.search(/<pre|!OKC|NOTAM/i));
    console.log(body.slice(i, i + 3000));
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
}
