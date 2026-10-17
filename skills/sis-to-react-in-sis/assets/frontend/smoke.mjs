// Browser smoke test for the starter, against a running app (local or deployed).
//   APP_URL=http://localhost:8501 npm run smoke        (from starter/frontend)
// Checks: renders, a background job completes through the bridge, the bundle is
// sent once per session, a rebuilt bundle swaps in without blanking the page,
// the hidden input never takes focus, no console errors, no off-page requests.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.APP_URL || "http://localhost:8501";
const BUNDLE = process.env.BUNDLE || path.join(here, "..", "ui", "sl_ui.js");
const VERSION = process.env.EXPECT_VERSION || JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8")).version;

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const hosts = new Set();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
page.on("request", (r) => hosts.add(new globalThis.URL(r.url()).host));
let failed = 0;
const t0 = Date.now();
const check = (name, ok, extra = "") => {
  console.log(`${String(Math.round((Date.now() - t0) / 100) / 10).padStart(5)}s ${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const text = () => page.$eval(".sl", (e) => e.innerText);

await page.goto(URL);
await page.waitForSelector(".sl .nav", { timeout: 90000 });
check("bundle version " + VERSION, (await page.evaluate(() => window.SnowUI.version)) === VERSION);
check("landing view renders", /Hello /.test(await text()));

const bridge = await page.evaluate(() => {
  const i = document.querySelector(".st-key-sl_bridge input");
  return { tab: i?.tabIndex, hidden: i?.getAttribute("aria-hidden") };
});
check("bridge input out of the tab order", bridge.tab === -1 && bridge.hidden === "true");

await page.waitForFunction(() => document.getElementById("sl-a-bundle")?.dataset.code === "", null, { timeout: 30000 }).catch(() => {});
check("bundle sent once: later reruns carry a placeholder",
  await page.evaluate(() => document.getElementById("sl-a-bundle")?.dataset.code === ""));

for (const w of [1440, 1100, 800]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.waitForTimeout(150);
  check(`nav fits at ${w}px`, await page.$eval(".sl .nav", (n) => n.scrollWidth <= n.clientWidth + 1));
}
await page.setViewportSize({ width: 1440, height: 900 });

// A background job end to end: request through the hidden input, pending, polled, result.
await page.getByRole("button", { name: "Slow data" }).click();
const before = await page.evaluate(() => document.activeElement?.tagName);
await page.waitForFunction(() => /WAITED/.test(document.querySelector(".sl")?.innerText || ""), null, { timeout: 60000 }).catch(() => {});
check("slow query result arrives through the bridge", /WAITED/.test(await text()));
check("focus never moved to the bridge input",
  (await page.evaluate(() => !document.activeElement?.closest(".st-key-sl_bridge"))) && before !== "INPUT");

// A rebuilt bundle reaches the open page on the next rerun and renders (no blank page).
const held = await page.evaluate(() => window.__slAssets?.bundle);
const orig = fs.readFileSync(BUNDLE);
fs.writeFileSync(BUNDLE, Buffer.concat([orig, Buffer.from("\n")]));
try {
  await page.getByRole("button", { name: "Home" }).click();
  await page.mouse.click(5, 450);       // focus the page, not an input, so "r" reruns
  await page.keyboard.press("r");
  await page.waitForFunction((h) => window.__slAssets?.bundle && window.__slAssets.bundle !== h, held, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
  check("rebuilt bundle swaps in", (await page.evaluate(() => window.__slAssets?.bundle)) !== held);
  check("app still renders after the swap", /Hello /.test(await text()));
} finally {
  fs.writeFileSync(BUNDLE, orig);
}

const local = new Set([new globalThis.URL(URL).host]);
const offPage = [...hosts].filter((h) => h && !local.has(h));
check("no requests to other hosts", offPage.length === 0, offPage.join(", "));
check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failed ? 1 : 0);
