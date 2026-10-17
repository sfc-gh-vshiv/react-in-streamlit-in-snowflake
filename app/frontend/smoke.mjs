// Interaction smoke test for Instant BI, against a running app (local or deployed).
//   APP_URL=http://localhost:8501 npm run smoke
// Uses real mouse input on the chart canvases: a bar click, a brush drag on the
// time series, Esc. Checks KPIs change, clicks cause no Python rerun, drill-downs
// arrive, nothing errors, and no request leaves the page's host.
import { chromium } from "playwright-core";

const URL = process.env.APP_URL || "http://localhost:8501";
const SHOTS = process.env.SHOTS;          // optional folder for screenshots
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
const errors = [], hosts = new Set();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
page.on("request", (r) => hosts.add(new globalThis.URL(r.url()).host));
let failed = 0;
const t0 = Date.now();
const check = (name, ok, extra = "") => {
  console.log(`${String(Math.round((Date.now() - t0) / 100) / 10).padStart(5)}s ${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const kpi = (k) => page.$eval(`[data-kpi=${k}] [data-value]`, (e) => +e.dataset.value);
const runs = () => page.$eval("[data-runs]", (e) => +e.dataset.runs);
const chips = () => page.$$eval(".ibi .chip:not(.clear)", (cs) => cs.map((c) => c.textContent));
const idle = () => page.waitForFunction(() => document.querySelector('[data-testid="stApp"]')?.dataset.testScriptState === "notRunning"
  && [...document.querySelectorAll("[data-panel]")].every((p) => p.dataset.busy === "0"), null, { timeout: 90000 });

/** Page coordinates of a bar, from the chart's own pixel mapping. */
async function barAt(chart, category) {
  return page.evaluate(([chart, category]) => {
    const c = window.__ibiCharts[chart], el = document.querySelector(`[data-chart=${chart}]`).getBoundingClientRect();
    const [x, y] = c.convertToPixel({ seriesIndex: 0 }, [category, 0]);
    const [, top] = c.convertToPixel({ seriesIndex: 0 }, [category, c.getOption().series[0].data.find((_, i) => c.getOption().xAxis[0].data[i] === category).value / 2]);
    return { x: el.left + x, y: el.top + top };
  }, [chart, category]);
}

await page.goto(URL);
await page.waitForSelector(".ibi .kpis", { timeout: 120000 });
await idle();
const total = await kpi("orders");
check("dashboard renders all orders", total > 1_000_000, String(total));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/instant-bi-start.png`, fullPage: true });

// 1. Click a bar: KPIs and every chart update in the browser, with no Python rerun for the charts.
const r0 = await runs();
const europe = await barAt("region", "EUROPE");
await page.mouse.click(europe.x, europe.y);
await page.waitForFunction(() => /Region: EUROPE/.test(document.querySelector(".ibi .chips").innerText), null, { timeout: 5000 }).catch(() => {});
check("bar click sets the filter", (await chips()).some((c) => /Region: EUROPE/.test(c)));
const afterClick = await kpi("orders");
check("KPIs follow the filter", afterClick > 0 && afterClick < total, String(afterClick));
check("charts updated without a Python rerun", (await runs()) === r0, `runs ${r0} -> ${await runs()}`);
const latency = await page.$eval("[data-latency]", (e) => e.dataset.latency);
check("on-screen latency measured", /^\d+$/.test(latency), `${latency} ms`);
await idle();
check("drill-downs answered after the click", (await page.$$eval("[data-panel=customers] tbody tr", (r) => r.length)) > 0);

// 2. Brush a range on the time series.
const box = await page.$eval("[data-chart=monthly]", (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
await page.mouse.move(box.x + box.w * 0.30, box.y + box.h * 0.5);
await page.mouse.down();
await page.mouse.move(box.x + box.w * 0.55, box.y + box.h * 0.5, { steps: 8 });
await page.mouse.up();
await page.waitForFunction(() => / to /.test(document.querySelector(".ibi .chips").innerText), null, { timeout: 5000 }).catch(() => {});
check("brush sets a month range", (await chips()).some((c) => / to /.test(c)), (await chips()).join(" | "));
await idle();
if (SHOTS) await page.screenshot({ path: `${SHOTS}/instant-bi-filtered.png`, fullPage: true });

// 3. Esc clears everything.
await page.mouse.click(5, 300);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Esc clears all filters", (await chips()).length === 0 && (await kpi("orders")) === total);

const offPage = [...hosts].filter((h) => h && h !== new globalThis.URL(URL).host);
check("no requests to other hosts", offPage.length === 0, offPage.join(", "));
check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
await browser.close();
process.exit(failed ? 1 : 0);
