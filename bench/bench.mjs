// One benchmark for both dashboards: the React app and its native twin.
//   REACT_URL=http://localhost:8602 NATIVE_URL=http://localhost:8603 RUNS=5 npm run bench
//
// Both apps get the same real input (Playwright mouse) and the same rules:
//   start    the input event's own timestamp, taken in the page (capture phase);
//            for a brush drag, the release that applies the selection.
//   charts   the last DOM change in the KPI tiles and the five main charts, once
//            300 ms pass with no further change in them.
//   settled  the same, including the drill-down panels, with no Streamlit run in
//            progress and every drill-down panel finished.
// The React charts draw on canvas, so they mark each finished draw on an attribute
// (data-render-seq), and KPI tiles expose their target value (data-value) so the
// number tween does not count as work. The native charts use Vega's SVG renderer,
// so their DOM changes directly. Each run starts from a fresh page (a new session).
// Writes ../qa/bench-<label>.json and prints medians.
import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNS = +(process.env.RUNS || 5);
const LABEL = process.env.LABEL || "local";
const QUIET = 300;

const APPS = {
  react: {
    url: process.env.REACT_URL || "http://localhost:8602",
    ready: ".ibi .kpis [data-value]",
    watch: [{ sel: "[data-chart]:not([data-chart=shipmodes])", attr: "data-render-seq" }, { sel: "[data-kpi] [data-value]", attr: "data-value" }],
    drill: [{ sel: "[data-panel]", attr: "data-busy" }, { sel: "[data-panel=customers] tbody" }, { sel: "[data-chart=shipmodes]", attr: "data-render-seq" }],
    drillDone: () => [...document.querySelectorAll("[data-panel]")].every((p) => p.dataset.busy === "0"),
    kpis: () => [...document.querySelectorAll("[data-kpi] .v")].map((e) => e.innerText),
    runs: () => +document.querySelector("[data-runs]").dataset.runs,
    topCustomer: () => document.querySelector("[data-panel=customers] tbody tr td")?.innerText || "",
  },
  native: {
    url: process.env.NATIVE_URL || "http://localhost:8603",
    ready: '.st-key-c_region svg path[aria-roledescription="bar"]',
    watch: [{ sel: ".st-key-c_kpis, .st-key-c_months, .st-key-c_region, .st-key-c_segment, .st-key-c_priority, .st-key-c_nation" }],
    drill: [{ sel: ".st-key-c_customers, .st-key-c_shipmodes" }],
    drillDone: () => true,
    kpis: () => [...document.querySelectorAll('[data-testid="stMetricValue"]')].map((e) => e.innerText),
    runs: () => {
      const t = [...document.querySelectorAll('[data-testid="stCaptionContainer"]')].map((e) => e.innerText).find((x) => /Reruns/.test(x)) || "";
      const [, full, frag] = t.match(/full (\d+) . fragment (\d+)/) || [];
      return +full + +frag;
    },
    topCustomer: () => document.querySelector('.st-key-c_customers [data-testid="stTable"] tbody tr th, .st-key-c_customers tbody tr td')?.innerText || "",
  },
};

// ------------------------------------------------------------------ input (same intent, real mouse)
async function click(page, app, dim, value) {
  if (app === "react") {
    const pt = await page.evaluate(([dim, value]) => {
      const c = window.__ibiCharts[dim], box = document.querySelector(`[data-chart=${dim}]`).getBoundingClientRect();
      const opt = c.getOption(), i = opt.xAxis[0].data.indexOf(value);
      const [x, y] = c.convertToPixel({ seriesIndex: 0 }, [value, opt.series[0].data[i].value / 2]);
      return { x: box.left + x, y: box.top + y };
    }, [dim, value]);
    await page.mouse.click(pt.x, pt.y);
  } else {
    await page.locator(`.st-key-c_${dim} path[aria-roledescription="bar"][aria-label^="${dim}: ${value};"]`).first().click();
  }
}

/** Drag across the time series between two month labels, so both apps select the same months. */
async function brush(page, app, fromLabel, toLabel) {
  const pts = await page.evaluate(([app, labels]) => {
    if (app === "react") {
      const c = window.__ibiCharts.monthly, box = document.querySelector("[data-chart=monthly]").getBoundingClientRect();
      const band = c.convertToPixel({ xAxisIndex: 0 }, "1992-02") - c.convertToPixel({ xAxisIndex: 0 }, "1992-01");
      return labels.map((m, i) => ({ x: box.left + c.convertToPixel({ xAxisIndex: 0 }, m) + (i ? 0.4 : -0.4) * band, y: box.top + box.height * 0.5 }));
    }
    const svg = document.querySelector(".st-key-c_months svg.marks"), box = svg.getBoundingClientRect();
    const ticks = [...svg.querySelectorAll("text")].filter((e) => /^\d{4}-01$/.test(e.textContent));
    const centre = (m) => { const t = ticks.find((e) => e.textContent === m).getBoundingClientRect(); return t.left + t.width / 2; };
    const band = (centre("1993-01") - centre("1992-01")) / 12;            // one month
    return labels.map((m, i) => ({ x: centre(m) + (i ? 0.4 : -0.4) * band, y: box.top + box.height * 0.4 }));
  }, [app, [fromLabel, toLabel]]);
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  await page.mouse.move(pts[1].x, pts[1].y, { steps: 8 });
  await page.mouse.up();
}

async function clearAll(page, app) {
  await page.locator(app === "react" ? ".ibi .chip.clear" : ".st-key-clear button").click();
}

const STEPS = [
  ["region EUROPE", (p, a) => click(p, a, "region", "EUROPE"), "pointerdown"],
  ["segment BUILDING", (p, a) => click(p, a, "segment", "BUILDING"), "pointerdown"],
  ["brush 1994-01 to 1996-01", (p, a) => brush(p, a, "1994-01", "1996-01"), "pointerup"],
  ["clear all", (p, a) => clearAll(p, a), "pointerdown"],
];

// ------------------------------------------------------------------ measurement (runs in the page)
function arm(cfg) {
  const B = (window.__bench = { t0: null, charts: 0, drill: 0, n: 0 });
  const inside = (node, list) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return list.some(({ sel }) => el?.closest?.(sel));
  };
  const relevant = (r, list) => list.some(({ sel, attr }) => {
    const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    if (!el?.closest?.(sel)) return false;
    return attr ? r.type === "attributes" && r.attributeName === attr : true;
  });
  B.mo?.disconnect?.();
  B.mo = new MutationObserver((recs) => {
    if (B.t0 == null) return;
    const now = performance.now();
    for (const r of recs) {
      if (relevant(r, cfg.watch)) { B.charts = now; B.n++; }
      if (relevant(r, cfg.watch) || relevant(r, cfg.drill)) B.drill = now;
    }
  });
  B.mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  for (const type of ["pointerdown", "pointerup"])
    document.addEventListener(type, (e) => { if (B.wantType === type && B.t0 == null) B.t0 = e.timeStamp; }, { capture: true });
  void inside;
}

async function measure(page, cfg, step) {
  await page.evaluate((type) => { Object.assign(window.__bench, { t0: null, charts: 0, drill: 0, n: 0, wantType: type }); }, step[2]);
  const runsBefore = await page.evaluate(cfg.runs);
  await step[1](page, cfg.name);
  // charts: quiet for QUIET ms in the KPI/chart regions
  const chartsMs = await page.evaluate(async (QUIET) => {
    const B = window.__bench, t = () => performance.now();
    const deadline = t() + 60000;
    while (t() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      if (B.t0 != null && B.charts && t() - B.charts >= QUIET) return Math.round(B.charts - B.t0);
    }
    return null;
  }, QUIET);
  // settled: drill-downs too, and Streamlit idle
  const settledMs = await page.evaluate(async ([QUIET, drillDoneSrc]) => {
    const B = window.__bench, t = () => performance.now(), done = new Function(`return (${drillDoneSrc})()`);
    const idle = () => document.querySelector('[data-testid="stApp"]')?.dataset.testScriptState === "notRunning";
    const deadline = t() + 120000;
    let quietSince = t();
    while (t() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      if (!(idle() && done())) { quietSince = t(); continue; }
      const last = Math.max(B.drill, B.charts);
      if (t() - Math.max(last, quietSince) >= QUIET) return Math.round(last - B.t0);
    }
    return null;
  }, [QUIET, cfg.drillDone.toString()]);
  await page.waitForTimeout(450);                                   // let the KPI number tween finish
  return {
    step: step[0], chartsMs, settledMs,
    pythonRuns: (await page.evaluate(cfg.runs)) - runsBefore,
    kpis: await page.evaluate(cfg.kpis), topCustomer: await page.evaluate(cfg.topCustomer),
  };
}

// ------------------------------------------------------------------ run
const browser = await chromium.launch();
const results = { label: LABEL, date: new Date().toISOString(), runs: RUNS, quietMs: QUIET, chromium: browser.version(), apps: {} };
for (const [name, cfg] of Object.entries(APPS)) {
  cfg.name = name;
  results.apps[name] = { url: cfg.url, runs: [] };
  for (let run = 0; run < RUNS; run++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(cfg.url);
    await page.waitForSelector(cfg.ready, { timeout: 180000 });
    await page.waitForFunction(([src]) => document.querySelector('[data-testid="stApp"]')?.dataset.testScriptState === "notRunning"
      && new Function(`return (${src})()`)(), [cfg.drillDone.toString()], { timeout: 180000 });
    await page.waitForTimeout(1000);
    await page.evaluate(arm, { watch: cfg.watch, drill: cfg.drill });
    const steps = [];
    for (const step of STEPS) steps.push(await measure(page, cfg, step));
    results.apps[name].runs.push({ run, steps, errors });
    console.log(`${name} run ${run + 1}: ` + steps.map((s) => `${s.step} ${s.chartsMs}/${s.settledMs} ms (${s.pythonRuns} runs)`).join(" | "));
    await page.close();
  }
}
await browser.close();

const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
results.summary = Object.fromEntries(Object.entries(results.apps).map(([name, a]) => [name,
  STEPS.map(([step], i) => ({
    step,
    chartsMs: median(a.runs.map((r) => r.steps[i].chartsMs)),
    settledMs: median(a.runs.map((r) => r.steps[i].settledMs)),
    pythonRuns: median(a.runs.map((r) => r.steps[i].pythonRuns)),
  }))]));
// Same input must give the same numbers in both apps.
results.parity = STEPS.map(([step], i) => {
  const r = results.apps.react.runs[0].steps[i], n = results.apps.native.runs[0].steps[i];
  return { step, kpisMatch: JSON.stringify(r.kpis) === JSON.stringify(n.kpis), react: r.kpis, native: n.kpis,
           topCustomerMatch: r.topCustomer === n.topCustomer, topCustomer: [r.topCustomer, n.topCustomer] };
});
mkdirSync(path.join(here, "..", "qa"), { recursive: true });
const out = path.join(here, "..", "qa", `bench-${LABEL}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log("\nmedians (charts / settled ms, python runs):");
for (const [name, rows] of Object.entries(results.summary))
  console.log(name.padEnd(7), rows.map((r) => `${r.step}: ${r.chartsMs}/${r.settledMs} (${r.pythonRuns})`).join(" | "));
console.log("parity:", results.parity.map((p) => `${p.step}: kpis ${p.kpisMatch ? "match" : "DIFFER"}, top ${p.topCustomerMatch ? "match" : "DIFFER"}`).join(" | "));
console.log("wrote", path.relative(process.cwd(), out));
