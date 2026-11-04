#!/usr/bin/env node
// One-off probe: which public (no login) FAA NOTAM pages answer from GitHub
// Actions, and what their output looks like. Prints status + the start of
// each body; writes nothing.
//
//   node scripts/probe-notams.js

import { execFileSync } from "node:child_process";

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
    console.log(`FAILED: ${err.message} · cause: ${err.cause?.code || err.cause?.message || "?"} ${err.cause?.hostname || ""}`);
    // what does the same host look like to curl (system certificates) and what does it present?
    try {
      const host = new URL(url).hostname;
      console.log(execFileSync("curl", ["-sS", "-m", "30", "-o", "/dev/null", "-w", "curl: HTTP %{http_code} ssl_verify=%{ssl_verify_result}\\n", "-A", UA, url], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim());
      console.log(execFileSync("bash", ["-c", `echo | openssl s_client -connect ${host}:443 -servername ${host} 2>&1 | grep -E "subject=|issuer=|Verify return|verify error|Verification" | head -12`], { encoding: "utf-8" }).trim());
    } catch (e2) {
      console.log(`diagnostics failed: ${String(e2.stderr || e2.message).trim().slice(0, 300)}`);
    }
  }
}
