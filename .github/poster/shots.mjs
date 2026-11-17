// TEMPORARY: screenshots of the live site for the squadron poster.
import { chromium } from "playwright";
const URL = "https://xcscanner.com/";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => localStorage.setItem("xcgpt-welcome-seen", "1"));
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("#plannerMap [data-field]", { timeout: 30000 });
await page.evaluate(() => (window.print = () => {}));
if (await page.isVisible("#tripOpenTab")) await page.click("#tripOpenTab");
for (const code of ["KOKC", "KTUL", "KICT"]) {
  await page.fill("#tripSearch", code);
  await page.press("#tripSearch", "Enter");
  await page.waitForTimeout(600);
}
// weather: flight category on
if (await page.isVisible("#wxCollapse")) {
  await page.click("#wxCollapse");
  await page.click('[data-wx-layer="cat"]').catch(() => {});
}
await page.waitForTimeout(4000);
await page.screenshot({ path: "shots/planner.png" });
// a field sheet
await page.locator('#plannerMap [data-field="KTUL"]').dispatchEvent("click");
await page.waitForSelector("#fieldPanel.open");
await page.waitForTimeout(1500);
await page.screenshot({ path: "shots/planner-field.png" });
await page.locator("#fieldPanel").screenshot({ path: "shots/field-sheet.png" });
// crew card
await page.click("#fieldClose").catch(() => {});
await page.click('#tripBody [data-trip="print"]');
await page.emulateMedia({ media: "print" });
await page.waitForTimeout(1000);
await page.locator("#crewCard").screenshot({ path: "shots/crew-card.png" });
await page.emulateMedia({ media: "screen" });
// welcome screen
const ctx2 = await browser.newContext({ viewport: { width: 1300, height: 1000 }, deviceScaleFactor: 2 });
const p2 = await ctx2.newPage();
await p2.goto(URL, { waitUntil: "networkidle" });
await p2.waitForTimeout(3000);
await p2.screenshot({ path: "shots/welcome.png" });
// phone
const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await ctx3.addInitScript(() => localStorage.setItem("xcgpt-welcome-seen", "1"));
const p3 = await ctx3.newPage();
await p3.goto(URL, { waitUntil: "networkidle" });
await p3.waitForTimeout(3000);
await p3.screenshot({ path: "shots/phone.png" });
await browser.close();
