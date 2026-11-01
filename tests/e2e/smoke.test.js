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
  execFileSync("node", ["scripts/stamp-version.js", dir, "e2etest1"]);
  site = await serve(dir);
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});

after(async () => {
  await browser?.close();
  await site?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function openPage(viewport = { width: 1280, height: 900 }) {
  // Service workers off: they take requests out of reach of page.route.
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
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

  await page.goto(site.url);
  await page.waitForFunction(() => document.getElementById("freshnessText")?.textContent.includes("loading") === false);
  return { page, context, errors };
}

const pins = (page) => page.locator("#plannerMap [data-field]");

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
    assert.match(await page.evaluate(() => location.hash), /fld=KOKC/);
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
    assert.equal(await page.locator('[data-ff="ron"], [data-ff="towered"]').count(), 0, "RON and Towered toggles are gone");
    assert.match(await page.textContent('[data-ff="fuel"]'), /Fuel available/);
    await page.click('[data-ff="fuel"]');
    await page.waitForFunction((n) => document.querySelectorAll("#plannerMap [data-field]").length < n, navCount);

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
    assert.match(await page.evaluate(() => location.hash), /air=[^&]*SR/);
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
    const ringed = () => page.evaluate(() => [...document.querySelectorAll("#plannerMap [data-field]")].filter((el) => Number.parseFloat(el.getAttribute("stroke-width")) >= 3).length);
    assert.equal(await ringed(), 0);
    // turning overlays on draws them as map images
    for (const k of ["cat", "lice", "hice", "thun"]) await page.click(`[data-wx-layer="${k}"]`);
    await page.waitForFunction(() => document.querySelectorAll("#plannerMap .leaflet-wx-pane img").length >= 3);
    await page.waitForFunction(() => [...document.querySelectorAll("#plannerMap [data-field]")].some((el) => Number.parseFloat(el.getAttribute("stroke-width")) >= 3));

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
    assert.match(await page.evaluate(() => location.hash), /wxt=\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}Z/);

    // clicking the map, or a field, never pops a weather bubble over it
    await page.mouse.click(700, 450);
    assert.equal(await page.locator(".leaflet-popup").count(), 0);

    // layers toggle off/on and a field sheet shows its forecast table
    await page.click('[data-wx-layer="thun"]');
    assert.equal(await page.locator('[data-wx-layer="thun"].active').count(), 0);
    assert.match(await page.evaluate(() => location.hash), /wx=[^&]*/);
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
    assert.match(await page.evaluate(() => location.hash), /app=LOCBC/);
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

test("comments: shown on a field and an airspace, post a comment, form survives sheet re-renders", async () => {
  const { page, context, errors } = await openPage();
  const store = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
  await page.route(/xc-gpt-comments\.fly\.dev/, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.method() === "POST") {
      const body = req.postDataJSON();
      assert.ok(body.elapsedMs >= 0 && body.subject === "field:KOKC");
      const comment = { id: `c${store.length}`, createdAt: new Date().toISOString(), freeFood: "", crewCar: "", aircard: "", fees: "", planespotters: "", amenities: "", visited: "", ...body };
      store.unshift(comment);
      return route.fulfill({ status: 201, headers: cors, json: { comment } });
    }
    const subject = new URL(req.url()).searchParams.get("subject");
    return route.fulfill({ status: 200, headers: cors, json: { comments: store.filter((c) => c.subject === subject) } });
  });
  try {
    await page.locator('#plannerMap [data-field="KOKC"]').dispatchEvent("click");
    await page.waitForSelector("#fieldPanel.open");
    await page.waitForSelector("#fieldComments .cm-list");
    assert.match(await page.textContent("#fieldComments"), /No comments yet/);

    // open the form, write something, then let the sheet re-render underneath (trip date change)
    await page.click('[data-cm-open="comment"]');
    await page.fill('#fieldComments [name="notes"]', "Great FBO, free cookies");
    await page.click('#fieldComments .cm-rating label:nth-of-type(4)');
    await page.selectOption('#fieldComments [name="freeFood"]', "yes");
    await page.fill('#fieldComments [name="fees"]', "$20 ramp");
    await page.waitForTimeout(2600); // the form has to have been open a human-ish while
    const dayChip = page.locator("[data-wx-day]").nth(1);
    if (await dayChip.count()) {
      await page.click("#wxCollapse");
      await page.locator("[data-wx-day]:not([disabled])").nth(1).click();
    }
    assert.equal(await page.inputValue('#fieldComments [name="notes"]'), "Great FBO, free cookies", "typing survives the sheet re-rendering");

    await page.click("#fieldComments .cm-post");
    await page.waitForSelector("#fieldComments .cm-item");
    const text = await page.textContent("#fieldComments");
    assert.match(text, /Great FBO, free cookies/);
    assert.match(text, /Free food ✓/);
    assert.match(text, /\$20 ramp/);
    assert.match(text, /1 comment/);
    assert.equal(store.length, 1);
    assert.equal(store[0].rating, "4");

    // the honeypot is not visible to people
    assert.equal(await page.locator('#fieldComments [name="website"]').first().isVisible(), false);

    // another field has its own (empty) thread, and an airspace area gets a field-free form
    await page.click("#fieldClose");
    await page.waitForSelector("#fieldPanel:not(.open)");
    assert.equal(await page.isHidden("#fieldComments"), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("TFRs are on by default, drawn, clickable, and open a sheet linking to the FAA", async () => {
  const { page, context, errors } = await openPage();
  try {
    assert.equal(await page.isChecked('[data-air-toggle="TFR"]'), true);
    await page.waitForFunction(() => /\d/.test(document.querySelector('[data-air-status="TFR"]')?.textContent || ""), null, { timeout: 15000 });
    assert.match(await page.textContent('[data-air-status="TFR"]'), /1/);
    // select it through the URL (the canvas shape itself isn't a DOM node)
    await page.goto(`${site.url}#/v=planner&air=TFR&as=${encodeURIComponent("TFR:6/9999")}`);
    await page.reload(); // a shared link: the area's file isn't loaded yet
    await page.waitForSelector("#fieldPanel.open");
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
    assert.match(await page.evaluate(() => location.hash), /trip=KOKC/);
    assert.match(await page.textContent("#tripBody"), /KEND KOKC KEND/);
    assert.match(await page.textContent("#tripBody"), /No RON stops/);

    // RON adds a night of per diem; a second stop is reorderable
    await page.check("#tripBody [data-trip-ron]");
    await page.waitForFunction(() => /1 night/.test(document.getElementById("tripBody").textContent));
    assert.match(await page.evaluate(() => location.hash), /trip=KOKC(%2A|\*)/);
    await page.click("#fieldClose");
    await page.locator('#plannerMap [data-field="KPNC"]').dispatchEvent("click");
    await page.click('[data-trip-toggle="KPNC"]');
    await page.waitForFunction(() => document.querySelectorAll("#tripBody .trip-stop").length === 2);
    await page.click('#tripBody [data-trip="up"][data-i="1"]');
    await page.waitForFunction(() => /KEND KPNC KOKC KEND/.test(document.getElementById("tripBody").textContent));

    // the crew card is filled and the print dialog requested
    await page.click('#tripBody [data-trip="print"]');
    assert.equal(await page.evaluate(() => window.__printed), true);
    const card = await page.textContent("#crewCard");
    assert.match(card, /Crew card · KEND/);
    assert.match(card, /1\. KPNC/);
    assert.match(card, /2\. KOKC/);
    assert.match(card, /Planning reference only/);

    await page.click('#tripBody [data-trip="clear"]');
    await page.waitForFunction(() => !document.querySelector("#tripBody .trip-stop"));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("ratings show on pins (label + 'Has comments' chip) and a problem report goes to the owner only", async () => {
  const { page, context, errors } = await openPage();
  const posts = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
  await page.route(/xc-gpt-comments\.fly\.dev/, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.method() === "POST") {
      posts.push(req.postDataJSON());
      return route.fulfill({ status: 201, headers: cors, json: { comment: { id: "r1", kind: "report" } } });
    }
    if (new URL(req.url()).pathname === "/summary") return route.fulfill({ status: 200, headers: cors, json: { summary: { "field:KOKC": { n: 3, avg: 4.5 } } } });
    return route.fulfill({ status: 200, headers: cors, json: { comments: [] } });
  });
  try {
    // reload so the summary request goes through the mock
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#plannerMap [data-field]").length > 0);
    await page.click('[data-ff="rated"]');
    await page.waitForFunction(() => document.querySelectorAll("#plannerMap [data-field]").length === 1);
    await page.click(".leaflet-control-zoom-in"); // labels appear from zoom 6
    await page.waitForFunction(() => /★4\.5/.test(document.querySelector("#plannerMap .rating-label")?.textContent || ""));

    await page.locator('#plannerMap [data-field="KOKC"]').dispatchEvent("click");
    await page.waitForSelector("#fieldComments .cm-buttons");
    await page.click('[data-cm-open="report"]');
    assert.equal(await page.isVisible("#fieldComments .cm-report"), true);
    await page.fill('#fieldComments .cm-report [name="notes"]', "The FBO phone number on this sheet is out of date.");
    await page.waitForTimeout(2600);
    await page.click("#fieldComments .cm-report .cm-post");
    await page.waitForFunction(() => /owner will see/.test(document.querySelector("#fieldComments .cm-thanks")?.textContent || ""));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].kind, "report");
    assert.equal(posts[0].subject, "field:KOKC");
    assert.equal(await page.locator("#fieldComments .cm-item").count(), 0, "a report never appears in the public list");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
