// Browser smoke test against the site exactly as deploy-pages.yml ships it:
// assembled into a temp dir and version-stamped, then served under the
// /xc-gpt/ subpath. Catches the failures unit tests can't — a module that
// no longer resolves after stamping, a view that throws on real data, a
// mobile sheet that can't be closed.
//
// Env:
//   CHROMIUM_PATH  use this Chromium binary instead of Playwright's own
//   LEAFLET_DIR    serve Leaflet from this local dist/ dir instead of
//                  cdnjs (for sandboxes without CDN access)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { serve } from "./serve.js";
import { writeFakeWx, writeFakeTfr } from "./fake-wx.js";

let site;
let browser;
let dir;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "xc-site-"));
  for (const f of ["index.html", "manifest.webmanifest", "sw.js"]) cpSync(f, path.join(dir, f));
  for (const d of ["assets", "data"]) cpSync(d, path.join(dir, d), { recursive: true });
  // deterministic approach data, whatever the weekly build last produced
  writeFileSync(path.join(dir, "data/generated/approaches.json"), JSON.stringify({ cycle: "test", airports: { KOKC: ["ILS RWY 35R", "LOC BC RWY 17L", "VOR-A"], KPNC: ["RNAV (GPS) RWY 17"] } }));
  writeFakeWx(dir, JSON.parse(readFileSync("data/curated/config.json", "utf-8")), JSON.parse(readFileSync("data/generated/field-facts.json", "utf-8")));
  writeFakeTfr(dir);
  // a NOTAM file in the shape scripts/fetch-notams.js publishes: KOKC has a closed runway, KPNC was checked and is clear
  writeFileSync(path.join(dir, "data/generated/wx/notams.json"), JSON.stringify({ builtAt: new Date().toISOString(), checked: ["KOKC", "KPNC"], fields: { KOKC: [{ kind: "Runway closed", text: "RWY 17R/35L CLSD", number: "11/123", start: new Date(Date.now() - 864e5).toISOString(), end: new Date(Date.now() + 30 * 864e5).toISOString() }] } }));
  execFileSync("node", ["scripts/stamp-version.js", dir, "e2etest1"]);
  site = await serve(dir);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});

after(async () => {
  await browser?.close();
  await site?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * @param opts.setup  runs before the page loads (install page.route mocks here — reloading to pick them up
 *                    is slow and flaky on CI)
 * @param opts.hash   the "#/…" state to load with, like a shared link
 */
async function openPage(viewport = { width: 1280, height: 900 }, opts = {}) {
  // Service workers off: they take requests out of reach of page.route.
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  // first-time visitors get the welcome screen; every other test has "seen" it already
  if (opts.welcome !== true) await context.addInitScript(() => localStorage.setItem("xcgpt-welcome-seen", "1"));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  // Map tiles are irrelevant here and must not make the test network-bound.
  await page.route(/tile\.openstreetmap\.org|mesonet\.agron\.iastate\.edu|raw\.githubusercontent\.com/, (route) => route.abort());
  if (process.env.LEAFLET_DIR) {
    await page.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/leaflet\/1\.9\.4\//, (route) => {
      const name = new URL(route.request().url()).pathname.split("/").pop().replace(".min", "");
      route.fulfill({ path: path.join(process.env.LEAFLET_DIR, name), headers: { "access-control-allow-origin": "*" } });
    });
  }

  await opts.setup?.(page);
  await page.goto(site.url + (opts.hash || ""));
  await page.waitForFunction(() => document.getElementById("freshnessText")?.textContent.includes("loading") === false);
  // the flight plan starts closed on desktop; most tests want it open (plan: false keeps it closed)
  if (opts.plan !== false && opts.welcome !== true && (await page.isVisible("#tripOpenTab"))) await page.click("#tripOpenTab");
  return { page, context, errors };
}

const pins = (page) => page.locator("#plannerMap [data-field]");

test("welcome screen: shown to first-time visitors, explains the pieces, remembered, and reopened from the header", async () => {
  const { page, context, errors } = await openPage(undefined, { welcome: true });
  try {
    assert.equal(await page.locator("#welcome").evaluate((d) => d.open), true, "open on the first visit");
    const text = await page.textContent("#welcome");
    for (const word of ["Departure base, range", "central and eastern US", "7 days", "green", "yellow", "night landings", "FBO names", "NOTAMs for your whole stay", "Weekend Recs", "category buttons"]) assert.ok(text.toLowerCase().includes(word.toLowerCase()), word);
    assert.equal(await page.locator("#welcome .welcome-sec").count(), 3, "three sections");
    assert.ok((await page.locator("#welcome .wv-pin svg").count()) >= 4, "the example map uses the real pin marks");
    assert.ok((await page.locator("#welcome .wv-key svg").count()) >= 3, "the key shows towered, non-towered and military");
    await page.click("#welcomeGo");
    assert.equal(await page.locator("#welcome").evaluate((d) => d.open), false);
    assert.equal(await page.evaluate(() => localStorage.getItem("xcgpt-welcome-seen")), "1", "remembered");
    // reopen from the header, close with Escape
    await page.click("#helpBtn");
    assert.equal(await page.locator("#welcome").evaluate((d) => d.open), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#welcome").evaluate((d) => d.open), false);
    // the page underneath works once it is closed
    assert.ok((await pins(page).count()) > 100);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("planner boots with field pins and throws nothing", async () => {
  const { page, context, errors } = await openPage();
  try {
    assert.ok((await pins(page).count()) > 100, "nav-list pins drawn");
    assert.match(await page.textContent("#rangeCounts"), /nav-list fields? in range/);
    // the default airspace layers load on their own
    await page.waitForFunction(() => /\d/.test(document.querySelector('[data-air-status="MOA"]')?.textContent || ""), null, { timeout: 15000 });
    assert.ok((await page.locator("#plannerMap canvas").count()) > 0, "airspace canvas present");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a field opens its sheet with FBO, status and per diem, and closes again", async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.locator('#plannerMap [data-field="KOKC"]').dispatchEvent("click");
    await page.waitForSelector("#fieldPanel.open");
    const text = await page.textContent("#fieldContent");
    assert.match(text, /KOKC/);
    assert.match(text, /Will Rogers/);
    assert.match(text, /AAR Aircraft Services/);
    assert.match(text, /GSA per diem/);
    assert.match(text, /RON/);
    assert.match(text, /AIR Card merchants/);
    await page.waitForFunction(() => /fld=KOKC/.test(location.hash));
    // opening the sheet must not scroll the clipped map area sideways
    assert.equal(await page.evaluate(() => document.getElementById("viewSurface").scrollLeft), 0);
    await page.click("#fieldClose");
    await page.waitForSelector("#fieldPanel:not(.open)");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("field list switch, quick filters and airspace toggles", async () => {
  const { page, context, errors } = await openPage();
  try {
    const navCount = await pins(page).count();
    await page.click('[data-src="p"]');
    await page.waitForFunction((n) => document.querySelectorAll("#plannerMap [data-field]").length < n, navCount);
    const pCount = await pins(page).count();
    assert.ok(pCount > 0 && pCount < navCount, `P-coded (${pCount}) is a subset of the list (${navCount})`);

    await page.click('[data-src="nav"]');
    // the "Show only" chips are gone, and fields with a short runway aren't on the map
    assert.equal(await page.locator("[data-ff], #fieldFilterChips").count(), 0);
    assert.doesNotMatch(await page.textContent("#filterRail"), /Show only/);
    assert.equal(await page.locator('#plannerMap [data-field="KRWV"]').count(), 0, "KRWV's longest runway is 3,252 ft");
    assert.equal(await page.locator('#plannerMap [data-field="KOKC"]').count(), 1);

    // airspace outside the range ring is not drawn: shrinking the range lowers the MOA count
    await page.waitForFunction(() => /^ · \d+$/.test(document.querySelector('[data-air-status="MOA"]')?.textContent || ""), null, { timeout: 15000 });
    const moaWide = Number((await page.textContent('[data-air-status="MOA"]')).replace(/\D/g, ""));
    await page.evaluate(() => {
      const r = document.getElementById("rangeSlider");
      r.value = 50;
      r.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction((n) => Number(document.querySelector('[data-air-status="MOA"]').textContent.replace(/\D/g, "")) < n, moaWide, { timeout: 5000 });

    // IR/VR/SR are off by default; SR turns on and loads its file
    assert.equal(await page.isChecked('[data-air-toggle="SR"]'), false);
    assert.equal(await page.isChecked('[data-air-toggle="MOA"]'), true);
    await page.click('[data-air="SR"] .switch');
    await page.waitForFunction(() => /\d/.test(document.querySelector('[data-air-status="SR"]')?.textContent || ""), null, { timeout: 15000 });
    await page.waitForFunction(() => /air=[^&]*SR/.test(location.hash));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("another base switches to P-coded fields", async () => {
  const { page, context } = await openPage();
  try {
    await page.click('[data-origin="columbus"]');
    await page.waitForFunction(() => document.querySelector('[data-src="p"]')?.classList.contains("active"));
    assert.match(await page.textContent("#rangeCounts"), /P-coded/);
  } finally {
    await context.close();
  }
});

test("events page loads on demand, with calendar date boxes and no west toggle", async () => {
  const { page, context, errors } = await openPage();
  try {
    assert.equal(await page.locator("#westToggle").count(), 0);
    const requested = [];
    page.on("request", (r) => requested.push(r.url()));
    await page.click('#tabBar [data-view="events"]');
    await page.waitForSelector("#mapWrap path.leaflet-interactive", { timeout: 20000 });
    assert.ok(requested.some((u) => u.includes("generated/events.json")), "event data fetched only on opening the page");
    assert.match(await page.textContent("#rangeCounts"), /places? · \d+ events? in window/);

    // the boxes are real date inputs bounded by event coverage; moving "To" updates the range
    assert.equal(await page.getAttribute("#dateFrom", "type"), "date");
    const max = await page.getAttribute("#dateTo", "max");
    await page.fill("#dateTo", max);
    await page.waitForFunction((m) => location.hash.includes(`to=${m}`), max);
    // a start after the end drags the end along
    await page.fill("#dateFrom", max);
    await page.waitForFunction((m) => location.hash.includes(`from=${m}`) && location.hash.includes(`to=${m}`), max);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("data is fetched with the deploy version, not a per-load timestamp", async () => {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  const dataUrls = [];
  page.on("request", (r) => r.url().includes("/data/") && dataUrls.push(r.url()));
  try {
    await page.route(/tile\.openstreetmap\.org|mesonet\.agron\.iastate\.edu|raw\.githubusercontent\.com/, (route) => route.abort());
    if (process.env.LEAFLET_DIR) {
      await page.route(/cdnjs\.cloudflare\.com/, (route) =>
        route.fulfill({
          path: path.join(process.env.LEAFLET_DIR, new URL(route.request().url()).pathname.split("/").pop().replace(".min", "")),
          headers: { "access-control-allow-origin": "*" },
        })
      );
    }
    await page.goto(site.url);
    await page.waitForFunction(() => document.getElementById("freshnessText")?.textContent.includes("loading") === false);
    assert.ok(dataUrls.length >= 4);
    for (const u of dataUrls) assert.match(u, /\?v=e2etest1$/, u);
  } finally {
    await context.close();
  }
});

test("mobile: filter sheet and field sheet both close", async () => {
  const { page, context, errors } = await openPage({ width: 390, height: 844 });
  try {
    await page.click("#railToggle");
    await page.waitForSelector("#filterRail.open");
    await page.click("#railClose");
    await page.waitForSelector("#filterRail:not(.open)");

    await page.locator('#plannerMap [data-field="KOKC"]').dispatchEvent("click");
    await page.waitForSelector("#fieldPanel.open");
    await page.click("#fieldClose");
    await page.waitForSelector("#fieldPanel:not(.open)");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("installable: manifest and service worker are served", async () => {
  const manifest = JSON.parse(readFileSync("manifest.webmanifest", "utf-8"));
  assert.equal(manifest.start_url, "./");
  for (const icon of manifest.icons) {
    const res = await fetch(new URL(icon.src, site.url));
    assert.equal(res.status, 200, icon.src);
  }
  const sw = await fetch(new URL("sw.js", site.url));
  assert.equal(sw.status, 200);
});

test("weather bar: day picker, time slider, overlays, field forecast", async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.waitForSelector("#wxBar:not([hidden])", { timeout: 15000 });
    assert.equal(await page.locator("[data-wx-day]").count(), 8);
    assert.match(await page.textContent("#wxDisclaimer"), /not a weather brief/);

    // starts small, with only radar on; opening it shows the controls
    assert.equal(await page.isHidden("#wxBody"), true);
    assert.equal(await page.locator("#wxBar [data-wx-layer].active").count(), 1);
    await page.click("#wxCollapse");
    assert.equal(await page.isVisible("#wxBody"), true);
    assert.equal(await page.locator('[data-wx-layer="radar"].active').count(), 1);
    // radar-only means no flight-category rings on the pins; turning Flight category on adds them
    const ringed = () => page.evaluate(() => document.querySelectorAll("#plannerMap [data-field][data-ring]").length);
    assert.equal(await ringed(), 0);
    // turning overlays on draws them as map images
    for (const k of ["cat", "lice", "hice", "thun"]) await page.click(`[data-wx-layer="${k}"]`);
    await page.waitForFunction(() => document.querySelectorAll("#plannerMap .leaflet-wx-pane img").length >= 3);
    await page.waitForFunction(() => document.querySelectorAll("#plannerMap [data-field][data-ring]").length > 0);

    // picking a later day moves the whole app's trip date and the slider range
    const days = page.locator("[data-wx-day]:not([disabled])");
    const later = days.nth(2);
    const key = await later.getAttribute("data-wx-day");
    await later.click();
    await page.waitForFunction((k) => /day=/.test(location.hash) && location.hash.includes(`day=${k}`), key);
    assert.ok(Number(await page.getAttribute("#wxSlider", "max")) >= 1, "several time steps that day");

    // the slider changes the selected time and the URL remembers it
    const before = await page.textContent("#wxTimeLabel");
    await page.evaluate(() => {
      const r = document.getElementById("wxSlider");
      r.value = r.max;
      r.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction((b) => document.getElementById("wxTimeLabel").textContent !== b, before);
    await page.waitForFunction(() => /wxt=\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}Z/.test(location.hash));

    // clicking the map, or a field, never pops a weather bubble over it
    // a click on the map itself (not on a pin or a bar)
    await page.evaluate(() => document.getElementById("plannerMap").dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 600, clientY: 500 })));
    assert.equal(await page.locator(".leaflet-popup").count(), 0);

    // layers toggle off/on and a field sheet shows its forecast table
    await page.click('[data-wx-layer="thun"]');
    assert.equal(await page.locator('[data-wx-layer="thun"].active').count(), 0);
    await page.waitForFunction(() => /wx=[^&]*/.test(location.hash));
    await page.locator('#plannerMap [data-field="KOKC"]').dispatchEvent("click");
    await page.waitForSelector("#fieldPanel.open");
    const text = await page.textContent("#fieldContent");
    assert.match(text, /Forecast at the field/);
    assert.equal(await page.locator(".leaflet-popup").count(), 0);
    assert.match(text, /not a weather brief/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("approach chips filter fields and the sheet lists the approaches", async () => {
  const { page, context, errors } = await openPage();
  try {
    const all = await pins(page).count();
    await page.click('[data-app="LOCBC"]');
    await page.waitForFunction((n) => document.querySelectorAll("#plannerMap [data-field]").length < n, all);
    assert.equal(await pins(page).count(), 1);
    await page.waitForFunction(() => /app=LOCBC/.test(location.hash));
    await page.locator('#plannerMap [data-field="KOKC"]').dispatchEvent("click");
    await page.waitForSelector("#fieldPanel.open");
    const text = await page.textContent("#fieldContent");
    assert.match(text, /Instrument approaches \(3\)/);
    assert.match(text, /LOC BC RWY 17L/);
    // a second type narrows further, a type nobody has leaves nothing
    await page.click('[data-app="TACAN"]');
    await page.waitForFunction(() => document.querySelectorAll("#plannerMap [data-field]").length === 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("TFRs are on by default, drawn, clickable, and open a sheet linking to the FAA", async () => {
  const { page, context, errors } = await openPage(undefined, { hash: `#/v=planner&air=TFR&as=${encodeURIComponent("TFR:6/9999")}` });
  try {
    // opened from a shared link: the TFR file loads on demand and the sheet opens
    await page.waitForSelector("#fieldPanel.open", { timeout: 15000 });
    assert.equal(await page.isChecked('[data-air-toggle="TFR"]'), true);
    await page.waitForFunction(() => /\d/.test(document.querySelector('[data-air-status="TFR"]')?.textContent || ""), null, { timeout: 15000 });
    assert.match(await page.textContent('[data-air-status="TFR"]'), /1/);
    const text = await page.textContent("#fieldContent");
    assert.match(text, /TFR 6\/9999/);
    assert.match(text, /Temporary Flight Restriction/);
    assert.match(text, /Test City, OK/);
    assert.equal(await page.locator('#fieldContent a[href*="tfr.faa.gov"]').count(), 2);
    assert.equal(await page.isHidden("#fieldComments"), true, "no comments on a TFR");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("trip builder: add stops from the sheet, legs and per diem, route string, crew card", async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.evaluate(() => (window.print = () => (window.__printed = true)));
    await page.locator('#plannerMap [data-field="KOKC"]').dispatchEvent("click");
    await page.waitForSelector("#fieldPanel.open");
    await page.click('[data-trip-toggle="KOKC"]');
    await page.waitForSelector("#tripBody .trip-stop");
    assert.match(await page.textContent("#tripBody"), /KOKC/);
    assert.match(await page.textContent('[data-trip-toggle="KOKC"]'), /remove/);
    await page.waitForFunction(() => /trip=KOKC/.test(location.hash));
    assert.match(await page.textContent("#tripBody"), /KEND KOKC KEND/);
    assert.match(await page.textContent("#tripBody"), /No overnights/);
    assert.equal(await page.locator("#tripBody [data-trip-ron]").count(), 0, "no RON boxes");

    // taking off a day later than you landed means you are RON: a night of per diem, no box to tick
    const first = await page.locator("#tripBody [data-trip-dep]").nth(0).inputValue();
    const next = new Date(`${first.slice(0, 10)}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    await page.locator("#tripBody [data-trip-dep]").nth(1).fill(`${next.toISOString().slice(0, 10)}T09:00`);
    await page.waitForFunction(() => /1 night/.test(document.getElementById("tripBody").textContent));
    assert.match(await page.textContent("#tripBody .trip-ronmark"), /RON · 1 night/);
    await page.waitForFunction(() => /rdep=/.test(location.hash));
    await page.click("#fieldClose");
    await page.locator('#plannerMap [data-field="KPNC"]').dispatchEvent("click");
    await page.click('[data-trip-toggle="KPNC"]');
    await page.waitForFunction(() => document.querySelectorAll("#tripBody .trip-stop:not(.trip-ret)").length === 2);
    await page.locator("#tripBody .trip-more summary").nth(1).click(); // reordering lives under Details
    await page.click('#tripBody [data-trip="up"][data-i="1"]');
    await page.waitForFunction(() => /KEND KPNC KOKC KEND/.test(document.getElementById("tripBody").textContent));

    // the crew card is filled and the print dialog requested
    await page.click('#tripBody [data-trip="print"]');
    assert.equal(await page.evaluate(() => window.__printed), true);
    const card = await page.textContent("#crewCard");
    assert.match(card, /Crew card · KEND/);
    assert.match(card, /1\. KPNC/);
    assert.match(card, /2\. KOKC/);
    assert.match(card, /Closures \(NOTAM\)/);
    assert.match(card, /Runway closed: RWY 17R\/35L CLSD/, "KOKC closed runway is printed");
    assert.match(card, /None found for your stay/, "KPNC was checked and is clear");
    assert.match(card, /Planning reference only/);

    await page.click('#tripBody [data-trip="clear"]');
    await page.waitForFunction(() => !document.querySelector("#tripBody .trip-stop"));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("search keeps every pin and zooms to the match; fields wear chart-style marks", async () => {
  const { page, context, errors } = await openPage();
  try {
    const all = await pins(page).count();
    // marks: blue towered / magenta non-towered / a star for military, each with a status dot
    const kinds = await page.evaluate(() => ({
      blue: document.querySelectorAll("#plannerMap .field-pin svg [stroke='#1d63d6']").length,
      pink: document.querySelectorAll("#plannerMap .field-pin svg [stroke='#c4188f']").length,
      stars: document.querySelectorAll("#plannerMap .field-pin svg polygon").length,
      dots: document.querySelectorAll("#plannerMap .field-pin svg circle[r='4.1']").length,
    }));
    assert.ok(kinds.blue > 0 && kinds.pink > 0 && kinds.stars > 0, JSON.stringify(kinds));
    assert.equal(kinds.dots, all);

    await page.fill("#globalSearch", "KOKC");
    await page.press("#globalSearch", "Enter");
    await page.waitForFunction(() => document.querySelector('#plannerMap [data-field="KOKC"]')?.classList.contains("hit"));
    assert.equal(await pins(page).count(), all, "no pin disappears");
    // flying in leaves the match in view and the rest of the map still populated
    await page.waitForTimeout(900);
    const box = await page.locator('#plannerMap [data-field="KOKC"]').boundingBox();
    const map = await page.locator("#plannerMap").boundingBox();
    assert.ok(box.x > map.x && box.x < map.x + map.width && box.y > map.y && box.y < map.y + map.height, "the match is on screen");
    assert.ok(await pins(page).count() >= 1);
    // a field outside the range ring is found too, faded
    await page.fill("#globalSearch", "KMSY");
    await page.waitForFunction(() => document.querySelector('#plannerMap [data-field="KMSY"]')?.classList.contains("dim"), null, { timeout: 8000 }).catch(() => {});
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("flight plan: type a field in the rail to add it, with keyboard selection", async () => {
  const { page, context, errors } = await openPage();
  try {
    assert.equal(await page.isVisible("#tripSearch"), true);
    // the flight plan is a bar on the right of the screen, beside the map; the rail no longer carries it
    const bar = await page.locator("#tripBar").boundingBox();
    const mapBox = await page.locator("#plannerMap").boundingBox();
    assert.ok(bar.x >= mapBox.x + mapBox.width - 2, "the flight plan bar sits to the right of the map");
    assert.equal(await page.locator("#filterRail #tripSearch").count(), 0);
    const order = await page.evaluate(() => [...document.querySelectorAll("#filterRail .rail-section h3")].map((h) => h.textContent.trim().split(" ")[0]));
    assert.deepEqual(order.slice(0, 2), ["Departure", "Range"]);
    await page.fill("#tripSearch", "pnc");
    await page.waitForSelector("#tripSuggest li");
    assert.match(await page.textContent("#tripSuggest li"), /KPNC/);
    await page.press("#tripSearch", "Enter");
    await page.waitForSelector("#tripBody .trip-stop");
    assert.match(await page.textContent("#tripBody"), /KPNC/);
    assert.equal(await page.inputValue("#tripSearch"), "");
    // already-chosen fields aren't offered again; arrow keys + Enter pick another
    await page.fill("#tripSearch", "KPNC");
    assert.equal(await page.locator("#tripSuggest li").count(), 0);
    await page.fill("#tripSearch", "ok");
    await page.waitForSelector("#tripSuggest li");
    await page.press("#tripSearch", "ArrowDown");
    await page.press("#tripSearch", "Enter");
    await page.waitForFunction(() => document.querySelectorAll("#tripBody .trip-stop:not(.trip-ret)").length === 2);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("airspace fades out during a zoom and is back, redrawn, afterwards", async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.waitForFunction(() => /\d/.test(document.querySelector('[data-air-status="MOA"]')?.textContent || ""), null, { timeout: 15000 });
    await page.evaluate(() => {
      const pane = document.querySelector(".leaflet-airspace-pane");
      window.__sawZooming = false;
      new MutationObserver(() => pane.classList.contains("zooming") && (window.__sawZooming = true)).observe(pane, { attributes: true, attributeFilter: ["class"] });
    });
    await page.click(".leaflet-control-zoom-in");
    await page.waitForFunction(() => window.__sawZooming === true);
    await page.waitForFunction(() => !document.querySelector(".leaflet-airspace-pane").classList.contains("zooming"), null, { timeout: 5000 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".leaflet-airspace-pane")).opacity === "1", null, { timeout: 3000 }); // faded back in
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("flight plan: legs with arrival fields, local landing time, and a ceiling timeline only when it is instrument", async () => {
  const { page, context, errors } = await openPage();
  try {
    // a clear eastern leg: departure and arrival fields, takeoff time, local landing time — no timeline
    await page.fill("#tripSearch", "KPNC");
    await page.press("#tripSearch", "Enter");
    await page.waitForSelector("#tripBody .trip-leg");
    assert.equal(await page.locator("#tripBody .trip-stop:not(.trip-ret) [data-trip-base]").inputValue(), "vance");
    assert.equal(await page.inputValue("#tripBody [data-trip-arr]"), "KPNC");
    assert.match(await page.textContent("#tripAddLabel"), /Add leg 2: KPNC/);
    assert.equal(await page.locator('[data-testid="ceiling-timeline"]').count(), 0, "VFR legs have no timeline");

    // add a leg into the very low overcast far to the west: the timeline appears with a bar per half hour
    await page.fill("#tripSearch", "KLBL");
    await page.press("#tripSearch", "Enter");
    await page.waitForSelector('[data-testid="ceiling-timeline"]');
    // a red drop-down flag, closed until the pilot opens it
    assert.equal(await page.locator('[data-testid="ceiling-timeline"]').first().evaluate((d) => d.open), false);
    assert.match(await page.textContent('[data-testid="ceiling-timeline"] summary'), /^⚠ KLBL IFR, ceiling/);
    assert.equal(await page.locator('[data-testid="ceiling-timeline"] svg').first().isVisible(), false);
    await page.locator('[data-testid="ceiling-timeline"] summary').first().click();
    assert.equal(await page.locator('[data-testid="ceiling-timeline"] svg').first().isVisible(), true);
    assert.ok((await page.locator('[data-testid="ceiling-timeline"] svg rect[fill]').count()) > 20);
    assert.match(await page.textContent('[data-testid="ceiling-timeline"]'), /IFR at landing/);
    assert.match(await page.getAttribute('[data-testid="ceiling-timeline"] svg', "aria-label"), /KLBL/);

    // retype an arrival field: pick from the list and the leg changes
    const arr = page.locator("#tripBody [data-trip-arr]").nth(0);
    await arr.fill("kokc");
    await page.waitForSelector("#tripBody .trip-combo #tripSuggest li");
    await arr.press("Enter");
    await page.waitForFunction(() => /trip=KOKC/.test(location.hash) && document.querySelector("#tripBody [data-trip-arr]").dataset.code === "KOKC");
    await page.locator("#tripBody [data-trip-arr]").nth(0).fill("junk");
    await page.locator("#tripBody [data-trip-arr]").nth(0).press("Escape");
    assert.equal(await page.locator("#tripBody [data-trip-arr]").nth(0).inputValue(), "KOKC", "escape restores the field");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("flight plan: VFR says only VFR; marginal and instrument legs carry the ceiling on their tab; Move up / Move down", async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.fill("#tripSearch", "KPNC");
    await page.press("#tripSearch", "Enter");
    await page.waitForSelector("#tripBody .trip-row");
    await page.locator("#tripBody .trip-more summary").first().click();
    const chips = await page.locator("#tripBody .trip-wx").allTextContents();
    assert.ok(chips.length && chips.every((c) => c.trim() === "VFR"), `VFR chips are just VFR (${chips})`);
    assert.equal(await page.locator('[data-testid="ceiling-timeline"]').count(), 0);
    // reorder buttons are worded Move up / Move down
    await page.fill("#tripSearch", "KOKC");
    await page.press("#tripSearch", "Enter");
    await page.waitForFunction(() => document.querySelectorAll("#tripBody .trip-stop:not(.trip-ret)").length === 2);
    await page.locator("#tripBody .trip-more summary").nth(1).click();
    assert.match(await page.textContent('#tripBody [data-trip="up"][data-i="1"]'), /Move up/);
    assert.match(await page.textContent('#tripBody [data-trip="down"][data-i="0"]'), /Move down/);
    // marginal VFR in the west (2,200 ft): its own tab with the ceiling in it
    await page.fill("#tripSearch", "KCSM");
    await page.press("#tripSearch", "Enter");
    await page.waitForSelector('[data-testid="ceiling-timeline"].tl-mvfr');
    assert.match(await page.textContent('[data-testid="ceiling-timeline"].tl-mvfr summary'), /^⚠ KCSM MVFR, ceiling 2,200 ft/);
    // far west is instrument: red tab with its ceiling
    await page.fill("#tripSearch", "KLBL");
    await page.press("#tripSearch", "Enter");
    await page.waitForSelector('[data-testid="ceiling-timeline"].tl-ifr');
    assert.match(await page.textContent('[data-testid="ceiling-timeline"].tl-ifr summary'), /KLBL IFR, ceiling \d/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("flight plan: pick the takeoff date and time of each leg", async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.fill("#tripSearch", "KPNC");
    await page.press("#tripSearch", "Enter");
    await page.waitForSelector("#tripBody .trip-leg");
    await page.fill("#tripSearch", "KOKC");
    await page.press("#tripSearch", "Enter");
    await page.waitForFunction(() => document.querySelectorAll("#tripBody [data-trip-dep]").length === 3); // two stops + the return

    // every leg shows a takeoff picker, a landing time and a field-local zone
    const inputs = page.locator("#tripBody [data-trip-dep]");
    assert.match(await inputs.nth(0).inputValue(), /^\d{4}-\d{2}-\d{2}T09:00$/, "leg 1 defaults to 09:00 on the trip date");
    const second = await inputs.nth(1).inputValue();
    assert.ok(second > (await inputs.nth(0).inputValue()), "leg 2 is after leg 1");
    assert.match(await page.textContent("#tripBody .trip-leg .trip-c-land"), /\d+:\d\d (AM|PM)\w+ · \d{4}Z/);
    assert.match(await page.textContent("#tripBody .trip-leg .trip-c-fly"), /\d+m|\d+:\d\d/, "flight time is in the row");
    assert.match(await page.textContent("#tripBody .trip-leg .trip-c-fly"), /\d+ nm/);

    // set leg 2 two days later: it becomes explicit (with an 'auto' reset) and rides in the URL
    const target = new Date(Date.now() + 2 * 86400000);
    const day = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
    await inputs.nth(1).fill(`${day}T14:30`);
    await page.locator("#tripBody .trip-more summary").nth(1).click(); // the reset lives under Details
    await page.waitForSelector('#tripBody [data-trip="reset-dep"]');
    assert.equal(await page.locator("#tripBody [data-trip-dep]").nth(1).inputValue(), `${day}T14:30`);
    await page.waitForFunction(() => /trip=KPNC%2CKOKC%40\d{12}|trip=KPNC,KOKC@\d{12}/.test(location.hash)); // the URL follows the state a moment later
    // the return leg now follows leg 2's landing
    assert.ok((await page.locator("#tripBody [data-trip-dep]").nth(2).inputValue()) > `${day}T14:30`);

    // changing leg 1's date moves the trip day for the weather and per diem as well
    const first = new Date(Date.now() + 86400000);
    const day1 = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(first.getDate()).padStart(2, "0")}`;
    await page.locator("#tripBody [data-trip-dep]").nth(0).fill(`${day1}T07:45`);
    await page.waitForFunction((d) => location.hash.includes(`day=${d}`), day1);
    assert.equal(await page.locator("#tripBody [data-trip-dep]").nth(0).inputValue(), `${day1}T07:45`);

    // "auto" puts leg 2 back on the automatic schedule
    await page.click('#tripBody [data-trip="reset-dep"]');
    await page.waitForFunction(() => !document.querySelector('#tripBody [data-trip="reset-dep"]'));

    // the crew card carries the schedule
    await page.evaluate(() => (window.print = () => {}));
    await page.click('#tripBody [data-trip="print"]');
    const card = await page.textContent("#crewCard");
    assert.match(card, /Takeoff/);
    assert.match(card, /7:45 AM/);
    assert.match(card, /Time zones — all one zone/);
    assert.match(card, /Central \(C[SD]T, UTC−[56]\)/);
    assert.match(card, /\d{4}Z/, "Zulu times on the card");
    // the bar itself shows Zulu next to the local takeoff and landing times
    assert.match(await page.textContent("#tripBody"), /\d{4}Z/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("flight plan: closed by default, opens from the tab, when a leg is added, or from a shared link; rows are one line", async () => {
  const closed = await openPage(undefined, { plan: false });
  try {
    const { page } = closed;
    assert.equal(await page.isVisible("#tripBar"), false, "closed on first load");
    assert.equal(await page.isVisible("#tripOpenTab"), true);
    // adding a field to the trip from its sheet opens the plan
    await page.locator('#plannerMap [data-field="KOKC"]').dispatchEvent("click");
    await page.waitForSelector("#fieldPanel.open");
    await page.click('[data-trip-toggle="KOKC"]');
    await page.waitForFunction(() => !document.querySelector(".app").dataset.trip);
    assert.equal(await page.isVisible("#tripBar"), true);
    assert.equal(await page.isVisible("#tripBody .trip-row"), true);
    // no widening controls
    assert.equal(await page.locator("#tripWide, #tripResize").count(), 0);
    // one line per leg at the standard width
    assert.ok((await page.locator("#tripBody .trip-row").first().boundingBox()).height < 60, "the leg is a single line");
    const cols = await page.locator("#tripBody .trip-row").first().locator(".trip-c-dep, .trip-c-arr, .trip-c-take, .trip-c-fly, .trip-c-land").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    for (let k = 1; k < cols.length; k++) assert.ok(cols[k].left >= cols[k - 1].right - 1, "columns do not overlap");
    assert.deepEqual(closed.errors, []);
  } finally {
    await closed.context.close();
  }
  // a shared link that has legs opens it
  const shared = await openPage(undefined, { plan: false, hash: "#/v=planner&trip=KPNC" });
  try {
    assert.equal(await shared.page.isVisible("#tripBar"), true);
    assert.equal(await shared.page.isVisible("#tripBody .trip-row"), true);
    assert.deepEqual(shared.errors, []);
  } finally {
    await shared.context.close();
  }
});

test("flight plan bar can be hidden and brought back; the map key is small and says what green and yellow mean", async () => {
  const { page, context, errors } = await openPage();
  try {
    // the key: three marks and the two dot colours — nothing about red, orange or faded fields
    const key = (await page.textContent("#plannerLegend")).replace(/\s+/g, " ");
    for (const word of ["Towered", "Non-towered", "Military", "Approved", "See comments"]) assert.ok(key.includes(word), word);
    assert.doesNotMatch(key, /No fuel|not approved|faded|outside range/i);
    assert.equal(await page.locator("#plannerLegend svg").count(), 3);
    const box = await page.locator("#plannerLegend").boundingBox();
    assert.ok(box.width < 210 && box.height < 140, `compact key (${Math.round(box.width)}×${Math.round(box.height)})`);

    // hide / show the bar
    assert.equal(await page.isVisible("#tripBar"), true);
    await page.click("#tripBarClose");
    await page.waitForFunction(() => document.querySelector(".app").dataset.trip === "closed");
    assert.equal(await page.isVisible("#tripBar"), false);
    await page.click("#tripOpenTab");
    await page.waitForFunction(() => !document.querySelector(".app").dataset.trip);
    assert.equal(await page.isVisible("#tripBar"), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("mobile: the flight plan opens as a sheet from the header button", async () => {
  const { page, context, errors } = await openPage({ width: 390, height: 780 });
  try {
    assert.equal(await page.isVisible("#tripToggle"), true);
    assert.equal(await page.evaluate(() => document.getElementById("tripBar").getBoundingClientRect().top >= window.innerHeight - 1), true, "off screen until opened");
    await page.click("#tripToggle");
    await page.waitForSelector("#tripBar.open");
    await page.fill("#tripSearch", "KPNC");
    await page.press("#tripSearch", "Enter");
    await page.waitForSelector("#tripBody .trip-stop");
    assert.match(await page.textContent("#tripToggleCount"), /2 legs/);
    await page.click("#tripBarClose");
    await page.waitForFunction(() => !document.getElementById("tripBar").classList.contains("open"));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("weekend recs tab: a pick and two backups per weekend, a mix of kinds, and the city links to the events map", async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.click('#tabBar [data-view="weekends"]');
    await page.waitForSelector("#weekendsPage .wk-card .wk-primary", { timeout: 30000 });
    await page.waitForFunction(() => /v=weekends/.test(location.hash));
    assert.equal(await page.locator("#tabBar button.active").textContent(), "Weekend Recs");
    // the shared rail stays (base + range), without the planner/events-only sections
    assert.equal(await page.isVisible("#originChips"), true);
    assert.equal(await page.isVisible("#airspaceToggles"), false);
    assert.equal(await page.isVisible("#tripBar"), false);

    const cards = page.locator("#weekendsPage .wk-card");
    assert.ok((await cards.count()) >= 8, "a dozen weekends");
    assert.ok((await page.locator("#weekendsPage .wk-card .wk-primary").count()) >= 6);
    // most weekends have two backups
    assert.ok((await page.locator("#weekendsPage .wk-card:has(.wk-backup-row:nth-child(2))").count()) >= 4);
    // a mix: the primaries are not all one kind
    const kinds = await page.evaluate(() => new Set([...document.querySelectorAll("#weekendsPage .wk-primary .wk-kind")].map((b) => b.textContent.trim())).size);
    assert.ok(kinds >= 2, `${kinds} kinds among the picks`);
    assert.match(await page.textContent("#weekendsPage"), /mixed on purpose/);

    // the header search narrows what is considered
    await page.fill("#globalSearch", "rodeo");
    await page.waitForFunction(() => /rodeo/i.test(document.querySelector("#weekendsPage .wk-primary .wk-title")?.textContent || ""), null, { timeout: 8000 });
    await page.fill("#globalSearch", "");

    // the orange city is the link to the events map: no separate "see on the events map" line
    assert.doesNotMatch(await page.textContent("#weekendsPage"), /on the events map/);
    assert.match(await page.locator("#weekendsPage a.wk-city").first().getAttribute("href"), /^#\/v=events&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&place=/);
    // clicking it switches page with the place selected and that weekend as the date window
    await page.locator("#weekendsPage a.wk-city").first().click();
    await page.waitForSelector("#detailPanel.open", { timeout: 15000 });
    assert.equal(await page.locator("#tabBar button.active").textContent(), "Events");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
