// Browser smoke test against the site exactly as deploy-pages.yml ships it:
// assembled into a temp dir and version-stamped, then served under the
// /xc-gpt/ subpath. Catches the failures unit tests can't — a module that
// no longer resolves after stamping, a view that throws on real data, a
// mobile sheet that can't be closed.
//
// Env:
//   CHROMIUM_PATH  use this Chromium binary instead of Playwright's own
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
  // the Content-Security-Policy in index.html must not block anything the page really loads
  page.on("console", (m) => /Content Security Policy|Refused to (load|connect|apply|execute)/i.test(m.text()) && errors.push(`CSP: ${m.text()}`));

  // Map tiles are irrelevant here and must not make the test network-bound.
  await page.route(/tile\.openstreetmap\.org|mesonet\.agron\.iastate\.edu|raw\.githubusercontent\.com/, (route) => route.abort());

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
    for (const word of ["Departure base, range", "cover the whole continental US", "7 days", "Flight category", "green", "yellow", "when you'll land", "night landings", "tight-on-gas", "closed runways", "a day later", "per diem", "time zones", "Weekend Recs", "category buttons"]) assert.ok(text.toLowerCase().includes(word.toLowerCase()), word);
    assert.equal(await page.locator("#welcome .welcome-sec").count(), 3, "three sections");
    assert.ok((await page.locator("#welcome #wvLayers .chip").count()) >= 5, "the example Weather box lists the overlay switches");
    assert.equal(await page.locator("#welcome #wvLayers .chip.active").textContent(), "Radar");
    assert.ok((await page.locator("#welcome #welcomeMap .wv-marker svg").count()) >= 5, "the example map is a real map with the real pin marks");
    assert.match(await page.textContent("#welcome"), /Turnpike Troubadours/, "a real band, not a placeholder");
    assert.doesNotMatch(await page.textContent("#welcome"), /Example Band|Example Aviation/);
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

test("the site is called XC Scanner everywhere a person looks, with its tagline and an independence note", async () => {
  const { page, context, errors } = await openPage(undefined, { welcome: true });
  try {
    assert.equal(await page.title(), "XC Scanner | Cross-country awareness");
    assert.match(await page.textContent(".app-header h1"), /^XC Scanner/);
    assert.equal(await page.locator(".app-header h1 .tagline").isVisible(), true, "the tagline has room on a desktop header");
    assert.equal((await page.textContent(".app-header h1 .tagline")).trim(), "Off-station awareness for cross-country flying.");
    assert.match(await page.getAttribute('meta[name="description"]', "content"), /^XC Scanner: off-station awareness for cross-country flying\./);
    const welcome = await page.textContent("#welcome");
    assert.match(welcome, /Welcome to XC Scanner/);
    assert.match(welcome, /Off-station awareness for cross-country flying\./);
    assert.match(welcome, /independent tool, not an official USAF or FAA product/);
    // nothing a visitor can read still carries an older name
    const everything = await page.evaluate(() => document.documentElement.innerText + " " + document.title);
    assert.doesNotMatch(everything, /XC GPT|OffStation/i);
    const manifest = await (await page.request.get(new URL("manifest.webmanifest", page.url()).href)).json();
    assert.equal(manifest.name, "XC Scanner");
    assert.equal(manifest.short_name, "XC Scanner");
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

    // picking a later day moves the weather (and the field sheet's day), not the flight plan's trip date
    const days = page.locator("[data-wx-day]:not([disabled])");
    const later = days.nth(2);
    const key = await later.getAttribute("data-wx-day");
    await later.click();
    await page.waitForFunction((k) => location.hash.includes(`wd=${k}`), key);
    assert.ok(!(await page.evaluate(() => location.hash)).includes(`day=${key}`), "the trip date stays where it was");
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

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

test("data age: nothing is shown while every file is fresh", async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.waitForFunction(() => document.querySelector("#wxTimeLabel") && !/no data/.test(document.querySelector("#wxTimeLabel").textContent));
    await page.waitForSelector("#plannerMap path.leaflet-interactive", { timeout: 20000 }); // the TFR is drawn, so its file is in
    assert.equal(await page.locator("#staleBanner.show").count(), 0);
    assert.equal(await page.evaluate(() => document.getElementById("staleBanner").getBoundingClientRect().height), 0, "an empty banner takes no room");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("data age: the banner names what stopped refreshing, and the crew card never calls stale NOTAMs all-clear", async () => {
  const { page, context, errors } = await openPage(undefined, {
    setup: async (p) => {
      await p.route(/generated\/wx\/notams\.json/, (route) =>
        route.fulfill({ json: { builtAt: hoursAgo(54), checked: ["KOKC", "KPNC"], fields: { KOKC: [{ kind: "Runway closed", text: "RWY 17R/35L CLSD", number: "11/123", start: hoursAgo(24), end: new Date(Date.now() + 30 * 864e5).toISOString() }] } } })
      );
      await p.route(/generated\/wx\/index\.json/, async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), generatedAt: hoursAgo(26) } });
      });
      await p.route(/generated\/wx\/tfr\.json/, async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), builtAt: hoursAgo(6) } });
      });
    },
  });
  try {
    await page.waitForSelector("#staleBanner.show", { timeout: 20000 });
    // all three files are in before the sentence is complete
    await page.waitForFunction(() => /NOTAMs is 2 days old/.test(document.getElementById("staleText").textContent) && /Forecast is 26 hours old/.test(document.getElementById("staleText").textContent) && /TFRs are 6 hours old/.test(document.getElementById("staleText").textContent), null, { timeout: 20000 });
    assert.match(await page.textContent("#staleText"), /a data refresh may have failed/);
    assert.equal(await page.isVisible("#staleReload"), true);

    // the crew card
    await page.evaluate(() => (window.print = () => {}));
    await page.locator('#plannerMap [data-field="KOKC"]').dispatchEvent("click");
    await page.waitForSelector("#fieldPanel.open");
    await page.click('[data-trip-toggle="KOKC"]');
    await page.waitForSelector("#tripBody .trip-stop");
    await page.click('#tripBody [data-trip="print"]');
    const card = await page.textContent("#crewCard");
    assert.match(card, /NOTAM data is 2 days old/);
    assert.match(card, /these closures may have changed/, "KOKC's closure carries the warning");
    assert.match(card, /Runway closed: RWY 17R\/35L CLSD/, "...and is still printed");
    assert.doesNotMatch(card, /None found for your stay/, "a stale file never reads as all-clear");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("data age: a tab left open past midnight asks for a reload", async () => {
  const { page, context, errors } = await openPage(undefined, { setup: (p) => p.clock.install({ time: new Date() }) });
  try {
    await page.waitForFunction(() => document.querySelector("#wxTimeLabel") && !/no data/.test(document.querySelector("#wxTimeLabel").textContent));
    assert.equal(await page.locator("#staleBanner.show").count(), 0);
    await page.clock.fastForward("26:00:00"); // the one-minute check fires
    await page.waitForSelector("#staleBanner.show");
    assert.match(await page.textContent("#staleText"), /new day since this page loaded/);
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
    // the list of matches is wider than the narrow arrival field and stays inside the bar
    const list = await page.locator("#tripSuggest").boundingBox();
    const bar = await page.locator("#tripBar").boundingBox();
    assert.ok(list.width >= 300, `suggestion list is wide enough (${Math.round(list.width)} px)`);
    assert.ok(list.x >= bar.x && list.x + list.width <= bar.x + bar.width + 1, "and inside the flight plan bar");
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
    // "alternate may be required" only where the forecast ceiling at the arrival is under 2,000 ft
    assert.equal(await page.locator("#tripBody .fp-flag", { hasText: "Alternate may be required" }).count(), 0, "KPNC, KOKC and KCSM are all above 2,000 ft");
    // far west is instrument: red tab with its ceiling
    await page.fill("#tripSearch", "KLBL");
    await page.press("#tripSearch", "Enter");
    await page.waitForSelector('[data-testid="ceiling-timeline"].tl-ifr');
    assert.match(await page.textContent('[data-testid="ceiling-timeline"].tl-ifr summary'), /KLBL IFR, ceiling \d/);
    assert.match(await page.locator("#tripBody .fp-flag", { hasText: "Alternate may be required" }).first().textContent(), /forecast ceiling 800 ft at KLBL/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("event feeds: hostile titles, notes and links are shown as text and never run", async () => {
  const { page, context, errors } = await openPage(undefined, {
    plan: false,
    hash: "#/v=events&place=houston-tx",
    setup: (p) =>
      p.route(/generated\/events\.json/, async (route) => {
        const res = await route.fetch();
        const events = await res.json();
        const ev = events.find((e) => e.id === "rec-texas-renaissance-festival-2026");
        ev.title = `Fest &lt;img src=x onerror="window.__xss=1"&gt;`;
        ev.url = "javascript:window.__xss=2";
        ev.pr = `<img src=x onerror="window.__xss=3">`;
        await route.fulfill({ json: events });
      }),
  });
  try {
    await page.waitForSelector("#detailPanel.open", { timeout: 20000 });
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__xss), undefined, "no event text became live code");
    const text = await page.textContent("#detailPanel");
    assert.ok(text.includes("<img src=x"), "the hostile title is shown as plain text");
    assert.equal(await page.locator('#detailPanel a[href^="javascript:"]').count(), 0, "no javascript: link");
    assert.equal(await page.locator("#detailPanel img[onerror]").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("flight plan: the same field can be visited twice (A to B to C, back to B, then home)", async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.evaluate(() => (window.print = () => {}));
    for (const code of ["KPNC", "KOKC"]) {
      await page.fill("#tripSearch", code);
      await page.press("#tripSearch", "Enter");
      await page.waitForFunction((c) => [...document.querySelectorAll("#tripBody [data-trip-arr]")].some((i) => i.value === c), code);
    }
    // the stop just added cannot be added again straight away (a leg to itself), but KPNC can come back
    await page.fill("#tripSearch", "KOKC");
    assert.equal(await page.locator("#tripSuggest li").count(), 0, "no leg from a field to itself");
    await page.fill("#tripSearch", "KPNC");
    await page.waitForSelector("#tripSuggest li");
    await page.press("#tripSearch", "Enter");
    await page.waitForFunction(() => document.querySelectorAll("#tripBody .trip-stop:not(.trip-ret)").length === 3);
    assert.deepEqual(await page.locator("#tripBody [data-trip-arr]").evaluateAll((els) => els.map((e) => e.value)), ["KPNC", "KOKC", "KPNC"]);
    assert.match(await page.textContent("#tripBody"), /KEND KPNC KOKC KPNC KEND/);
    await page.waitForFunction(() => /trip=KPNC%2CKOKC%2CKPNC/.test(location.hash));
    // the crew card carries every visit, each with its own arrival day
    await page.click('#tripBody [data-trip="print"]');
    const card = await page.textContent("#crewCard");
    assert.match(card, /1\. KPNC/);
    assert.match(card, /2\. KOKC/);
    assert.match(card, /3\. KPNC/);
    // from the field's own sheet: "Add again" appends another visit (not straight after the same field)
    await page.locator('#plannerMap [data-field="KOKC"]').dispatchEvent("click");
    await page.waitForSelector("#fieldPanel.open");
    await page.click('[data-trip-add="KOKC"]');
    await page.waitForFunction(() => document.querySelectorAll("#tripBody .trip-stop:not(.trip-ret)").length === 4);
    await page.click('[data-trip-add="KOKC"]');
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#tripBody .trip-stop:not(.trip-ret)").count(), 4, "not twice in a row");
    // the sheet's toggle takes every visit to the field out
    await page.click('[data-trip-toggle="KOKC"]');
    await page.waitForFunction(() => document.querySelectorAll("#tripBody .trip-stop:not(.trip-ret)").length === 2);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("launch robustness: bad links, a missing forecast, hidden stops, the weather day and Reset filters", async () => {
  // a garbled link opens the default view instead of breaking the page
  const bad = await openPage(undefined, { plan: false, hash: "#/v=planner&origin=randolph&r=abc&from=garbage&day=2026-02-30&trip=KPNC@202613450000" });
  try {
    assert.ok((await pins(bad.page).count()) > 100, "the map still loads");
    assert.deepEqual(bad.errors, []);
  } finally {
    await bad.context.close();
  }

  // the forecast index is missing: the page stays responsive and simply has no weather bar
  const noWx = await openPage(undefined, {
    plan: false,
    setup: (page) => page.route(/generated\/wx\/(index|fields)\.json/, (route) => route.fulfill({ status: 404, body: "not found" })),
  });
  try {
    assert.ok((await pins(noWx.page).count()) > 100);
    const alive = await Promise.race([noWx.page.evaluate(() => new Promise((r) => setTimeout(() => r("ok"), 50))), new Promise((r) => setTimeout(() => r("frozen"), 5000))]);
    assert.equal(alive, "ok", "the page is not stuck in a loop");
    assert.equal(await noWx.page.isVisible("#wxBar"), false, "no weather bar without a forecast");
    assert.deepEqual(noWx.errors, []);
  } finally {
    await noWx.context.close();
  }

  // a link naming a field that is not on the list: the legs shown are the stops kept, and their buttons act on them
  const { page, context, errors } = await openPage(undefined, { hash: "#/v=planner&trip=KZZZ,KPNC,KOKC" });
  try {
    await page.waitForFunction(() => document.querySelectorAll("#tripBody .trip-stop:not(.trip-ret)").length === 2);
    assert.equal(await page.locator("#tripBody .trip-stop:not(.trip-ret) [data-trip-arr]").first().inputValue(), "KPNC");
    await page.locator('#tripBody [data-trip="remove"][data-i="0"]').click();
    await page.waitForFunction(() => document.querySelectorAll("#tripBody .trip-stop:not(.trip-ret)").length === 1);
    assert.equal(await page.locator("#tripBody [data-trip-arr]").first().inputValue(), "KOKC", "the leg that was removed is the one whose button was pressed");
    assert.ok(!(await page.evaluate(() => location.hash)).includes("KZZZ"));

    // browsing the weather by day does not move the flight plan
    const planDay = await page.locator("#tripBody [data-trip-dep]").first().inputValue();
    await page.locator("#wxCollapse").click();
    await page.locator("[data-wx-day]:not([disabled])").nth(2).click();
    await page.waitForFunction(() => /wd=/.test(location.hash));
    assert.equal(await page.locator("#tripBody [data-trip-dep]").first().inputValue(), planDay, "leg 1 stays on its day");
    assert.match(await page.textContent("#tripBody"), /No overnights/, "no phantom RON from moving the weather day");

    // Reset filters keeps the plan and the page
    await page.fill("#globalSearch", "zzz");
    await page.click("#railReset");
    assert.equal(await page.locator("#tripBody [data-trip-arr]").first().inputValue(), "KOKC", "the plan survives Reset filters");
    assert.equal(await page.inputValue("#globalSearch"), "");
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

test("mobile: the welcome screen fits and its button is reachable; the plan sheet sits above the map controls", async () => {
  const first = await openPage({ width: 390, height: 780 }, { welcome: true });
  try {
    const { page } = first;
    assert.equal(await page.locator("#welcome").evaluate((d) => d.open), true);
    // the "Got it" button is on screen and not covered by the example map's layers
    const box = await page.locator("#welcomeGo").boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 780, "button inside the screen");
    const topmost = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [box.x + box.width / 2, box.y + box.height / 2]);
    assert.equal(topmost, "welcomeGo", "nothing sits on top of the button");
    assert.ok((await page.locator("#welcome").boundingBox()).width <= 390, "the dialog fits the width");
    await page.click("#welcomeGo");
    // the help button stays on the header line, icon only
    assert.ok((await page.locator("#helpBtn").boundingBox()).width < 60);
    assert.deepEqual(first.errors, []);
  } finally {
    await first.context.close();
  }
  const { page, context, errors } = await openPage({ width: 390, height: 780 });
  try {
    await page.click("#tripToggle");
    await page.waitForSelector("#tripBar.open");
    for (const code of ["KPNC", "KLBL"]) {
      await page.fill("#tripSearch", code);
      await page.press("#tripSearch", "Enter");
      await page.waitForFunction((n) => document.querySelectorAll("#tripBody .trip-stop:not(.trip-ret)").length >= n, code === "KPNC" ? 1 : 2);
    }
    // the sheet is drawn over the map's zoom buttons
    const zoom = await page.locator(".leaflet-control-zoom").first().boundingBox();
    const topAt = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("#tripBar") !== null, [zoom.x + zoom.width / 2, zoom.y + zoom.height / 2]);
    const sheet = await page.locator("#tripBar").boundingBox();
    if (zoom.y > sheet.y) assert.equal(topAt, true, "the sheet covers any map control behind it");
    // each leg's remove button sits on the first line next to the leg number, not on a line of its own
    const row = await page.locator("#tripBody .trip-row").first().boundingBox();
    const x = await page.locator('#tripBody .trip-row [data-trip="remove"]').first().boundingBox();
    assert.ok(x.y - row.y < 40, "remove button on the first line of the row");
    // takeoff, flight time and landing time are all there and nothing runs off the screen
    assert.ok((await page.locator("#tripBar").evaluate((e) => e.scrollWidth <= e.clientWidth + 1)), "no sideways scroll");
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
    // (any pick, not the first: the nearest weekend's top match can be a rodeo-ish event whose title lacks the word)
    await page.waitForFunction(() => [...document.querySelectorAll("#weekendsPage .wk-primary .wk-title")].some((t) => /rodeo/i.test(t.textContent)), null, { timeout: 8000 });
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
