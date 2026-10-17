// Local smoke test for a React-in-SiS app.  Run: node smoke.mjs  (app on localhost:8505)
// Set CHROME to a Chromium/headless-shell binary if playwright-core can't find one.
import { chromium } from "playwright-core";
import fs from "fs";

const URL = process.env.APP_URL || "http://localhost:8505";
const VERSION = process.env.EXPECT_VERSION || "app-1";
const BUNDLE = process.env.BUNDLE || "../ui/sl_ui.js";
const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
let failed = 0;
const t0 = Date.now();
const check = (name, ok) => { console.log(`${Math.round((Date.now() - t0) / 1000)}s ${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; };

await p.goto(URL);
await p.waitForSelector(".sl .nav", { timeout: 90000 });
check("bundle version " + VERSION, (await p.evaluate(() => window.SnowUI.version)) === VERSION);

// nav fits at common Snowsight widths
for (const w of [1440, 1100, 800]) {
  await p.setViewportSize({ width: w, height: 900 });
  await p.waitForTimeout(200);
  check(`nav fits at ${w}px`, await p.$eval(".sl .nav", (n) => n.scrollWidth <= n.clientWidth + 1));
}
await p.setViewportSize({ width: 1440, height: 900 });

// every tab renders something (adapt labels/selectors)
for (const label of ["Slow data", "Home"]) {
  await p.getByRole("button", { name: label }).click();
  await p.waitForTimeout(4000);
  check(`${label} renders`, (await p.$eval(".sl", (e) => e.innerText.trim().length)) > 0);
}

// scroll survives polling reruns
const main = "[data-testid=stMain]";
await p.$eval(main, (e) => { e.scrollTop = 400; window.__minTop = 1e9; const f = () => { window.__minTop = Math.min(window.__minTop, e.scrollTop); requestAnimationFrame(f); }; f(); });
await p.waitForTimeout(8000);
const top = await p.evaluate(() => window.__minTop);
check("scroll position stable (if page is scrollable)", top !== 0 || (await p.$eval(main, (e) => e.scrollHeight <= e.clientHeight + 400)));

// hash-keyed loader picks up a rebuilt bundle on the next rerun
const before = await p.evaluate(() => window.__slBundle);
const orig = fs.readFileSync(BUNDLE);
fs.writeFileSync(BUNDLE, Buffer.concat([orig, Buffer.from("\n")]));
try {
  await p.locator("body").click({ position: { x: 5, y: 5 } });
  await p.keyboard.press("r");
  await p.waitForFunction((h) => window.__slBundle && window.__slBundle !== h, before, { timeout: 30000 }).catch(() => {});
  check("bundle reloads after rebuild", (await p.evaluate(() => window.__slBundle)) !== before);
} finally {
  fs.writeFileSync(BUNDLE, orig);
}

check("no console errors", errs.length === 0);
console.log(failed ? `${failed} FAILED` : "ALL PASSED", errs.slice(0, 5));
await b.close();
process.exit(failed ? 1 : 0);
