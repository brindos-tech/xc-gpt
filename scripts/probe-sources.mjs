// TEMPORARY probe #4 (AIR Card FBO locator) — removed before the PR.
const show = async (label, url, opts) => {
  try {
    const r = await fetch(url, opts);
    const t = await r.text();
    console.log(`\n===== ${label} ${r.status} ${r.headers.get("content-type")} len=${t.length}\n` + t.replace(/\s+/g, " ").slice(0, 4000));
    return t;
  } catch (e) { console.log(`\n===== ${label} ERR ${e}`); return ""; }
};
const page = await show("form", "https://aircardsys.com/cgi-bin/fbo_locate");
console.log("\nFORMS:", [...page.matchAll(/<form[^>]*>/gi)].map((m) => m[0]));
console.log("INPUTS:", [...page.matchAll(/<(input|select)[^>]*>/gi)].map((m) => m[0]).slice(0, 40));
await show("robots", "https://aircardsys.com/robots.txt");
await show("q-icao GET", "https://aircardsys.com/cgi-bin/fbo_locate?icao=KOKC");
await show("q-icao POST", "https://aircardsys.com/cgi-bin/fbo_locate", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "icao=KOKC&submit=Search" });
await show("q-state POST", "https://aircardsys.com/cgi-bin/fbo_locate", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "state=OK&submit=Search" });
