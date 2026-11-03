// One benchmark for the dashboards: the React app, its native twin, and the same React UI
// on Snowflake App Runtime (sar_app/).
//   REACT_URL=http://localhost:8602 NATIVE_URL=http://localhost:8603 RUNS=5 npm run bench
//   APPS=react,sar SAR_URL=http://localhost:3311 LABEL=sis-vs-sar npm run bench
// APPS picks the targets (default react,native). STORAGE_STATE points at a Playwright
// storage-state file for apps behind a sign-in (a deployed App Runtime URL).
//
// Both apps get the same real input (Playwright mouse) and the same rules:
//   start    the input event's own timestamp, taken in the page (capture phase);
//            for a brush drag, the release that applies the selection.
//   charts   the last DOM change in the KPI tiles and the five main charts, once
//            300 ms pass with no further change in them.
//   settled  the same, including the drill-down panels, with no Streamlit run in
//            progress and every drill-down panel finished.
// The React charts draw on canvas, so they mark the first frame drawn after each new
// option on an attribute (data-render-seq), and KPI tiles expose their target value
// (data-value) so the number tween does not count as work. Pages ask for reduced
// motion, so the React app skips its 250 ms transitions and that first frame is the
// final picture (with motion on, the transition starts at the same moment). The native charts use Vega's SVG renderer,
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
const STORAGE_STATE = process.env.STORAGE_STATE || undefined;

// "Idle" means no server work pending: no Streamlit run (SiS) or no fetch in flight (SAR).
const streamlitIdle = () => document.querySelector('[data-testid="stApp"]')?.dataset.testScriptState === "notRunning";
const fetchIdle = () => window.__sarInflight === 0;

const APPS = {
  react: {
    url: process.env.REACT_URL || "http://localhost:8602",
    idle: streamlitIdle,
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
    idle: streamlitIdle,
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
// The App Runtime port runs the same React components, so it shares the React selectors
// and input; its meter counts server requests instead of Python reruns.
APPS.sar = { ...APPS.react, url: process.env.SAR_URL || "http://localhost:3311", idle: fetchIdle };
const PICKED = (process.env.APPS || "react,native").split(",").map((s) => s.trim()).filter(Boolean);
for (const name of PICKED) if (!APPS[name]) throw new Error(`unknown app ${name}; choose from ${Object.keys(APPS)}`);
const uiOf = (name) => (name === "native" ? "native" : "react");

// ------------------------------------------------------------------ frames
// Deployed SiS renders inside Snowsight iframes. A "view" points evaluate/locator at the frame
// that holds the dashboard and shifts mouse coordinates by that frame's position on the page.
// Locally and on App Runtime the dashboard is in the main frame, so the offset is zero.
// A suspended App Runtime service answers its first visits with a JSON ERROR_SERVICE_UNAVAILABLE
// body while it resumes; a person would reload, so the bench navigates to the URL again every
// 2 s and counts it (a fresh navigation, since in-tab reloads did not seem to wake the service).
async function findFrame(page, sel, timeout, stats = {}, url) {
  const deadline = Date.now() + timeout;
  stats.resumeReloads = 0;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    for (const f of page.frames()) if (await f.$(sel).catch(() => null)) return f;
    const body = await page.evaluate(() => document.body?.innerText?.slice(0, 400) || "").catch(() => "");
    if (body.includes("ERROR_SERVICE_UNAVAILABLE") && Date.now() - lastReload > 2000) {
      stats.resumeReloads++; lastReload = Date.now();
      await page.goto(url).catch(() => {});
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`no frame shows ${sel} after ${timeout} ms`);
}
async function frameOffset(frame) {
  let x = 0, y = 0;
  for (let f = frame; f.parentFrame(); f = f.parentFrame()) {
    const box = await (await f.frameElement()).boundingBox();
    x += box.x; y += box.y;
  }
  return { x, y };
}
function view(page, frame) {
  const at = async (fn) => { const o = await frameOffset(frame); return fn(o); };
  return {
    evaluate: (...a) => frame.evaluate(...a),
    locator: (sel) => frame.locator(sel),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    mouse: {
      click: (x, y) => at((o) => page.mouse.click(x + o.x, y + o.y)),
      move: (x, y, opts) => at((o) => page.mouse.move(x + o.x, y + o.y, opts)),
      down: () => page.mouse.down(),
      up: () => page.mouse.up(),
    },
  };
}

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
      const band = c.convertToPixel({ xAxisIndex: 0 }, "2020-02") - c.convertToPixel({ xAxisIndex: 0 }, "2020-01");
      return labels.map((m, i) => ({ x: box.left + c.convertToPixel({ xAxisIndex: 0 }, m) + (i ? 0.4 : -0.4) * band, y: box.top + box.height * 0.5 }));
    }
    const svg = document.querySelector(".st-key-c_months svg.marks"), box = svg.getBoundingClientRect();
    const ticks = [...svg.querySelectorAll("text")].filter((e) => /^\d{4}-01$/.test(e.textContent));
    const centre = (m) => { const t = ticks.find((e) => e.textContent === m).getBoundingClientRect(); return t.left + t.width / 2; };
    const band = (centre("2021-01") - centre("2020-01")) / 12;            // one month
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
  ["region EMEA", (p, a) => click(p, a, "region", "EMEA"), "pointerdown"],
  ["segment Construction", (p, a) => click(p, a, "segment", "Construction"), "pointerdown"],
  ["brush 2022-01 to 2024-01", (p, a) => brush(p, a, "2022-01", "2024-01"), "pointerup"],
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
  await step[1](page, uiOf(cfg.name));
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
  const settledMs = await page.evaluate(settleIn(cfg), QUIET);
  await page.waitForTimeout(450);                                   // let the KPI number tween finish
  return {
    step: step[0], chartsMs, settledMs,
    pythonRuns: (await page.evaluate(cfg.runs)) - runsBefore,
    kpis: await page.evaluate(cfg.kpis), topCustomer: await page.evaluate(cfg.topCustomer),
  };
}

// The Snowsight frame forbids eval in the page (CSP), so the predicates are stitched into one
// function here in Node and handed to Playwright, which injects it through the debugger.
const readyIn = (cfg) => eval(`() => (${cfg.idle})() && (${cfg.drillDone})()`);
const settleIn = (cfg) => eval(`(async (QUIET) => {
    const B = window.__bench, t = () => performance.now(), done = ${cfg.drillDone}, idle = ${cfg.idle};
    const deadline = t() + 120000;
    let quietSince = t();
    while (t() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      if (!(idle() && done())) { quietSince = t(); continue; }
      const last = Math.max(B.drill, B.charts);
      if (t() - Math.max(last, quietSince) >= QUIET) return Math.round(last - B.t0);
    }
    return null;
  })`);

// ------------------------------------------------------------------ run
const browser = await chromium.launch();
const results = { label: LABEL, date: new Date().toISOString(), runs: RUNS, quietMs: QUIET, reducedMotion: true, chromium: browser.version(), apps: {} };
for (const name of PICKED) {
  const cfg = APPS[name];
  cfg.name = name;
  results.apps[name] = { url: /^https?:\/\/localhost/.test(cfg.url) ? cfg.url : "(deployed)", runs: [] };
  for (let run = 0; run < RUNS; run++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1400 }, reducedMotion: "reduce", storageState: STORAGE_STATE });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const t0 = Date.now();
    await page.goto(cfg.url);
    const stats = {};
    const frame = await findFrame(page, cfg.ready, 600000, stats, cfg.url);
    const firstPaintMs = Date.now() - t0;
    await frame.waitForFunction(readyIn(cfg), undefined, { timeout: 180000 });
    const loadedMs = Date.now() - t0;
    await page.waitForTimeout(1000);
    const v = view(page, frame);
    await v.evaluate(arm, { watch: cfg.watch, drill: cfg.drill });
    const steps = [];
    for (const step of STEPS) steps.push(await measure(v, cfg, step));
    results.apps[name].runs.push({ run, firstPaintMs, loadedMs, resumeReloads: stats.resumeReloads, steps, errors });
    console.log(`${name} run ${run + 1}: load ${firstPaintMs}/${loadedMs} ms (${stats.resumeReloads} resume reloads) | ` + steps.map((s) => `${s.step} ${s.chartsMs}/${s.settledMs} ms (${s.pythonRuns} runs)`).join(" | "));
    await page.close();
  }
}
await browser.close();

const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
results.summary = Object.fromEntries(Object.entries(results.apps).map(([name, a]) => [name,
  [{ step: "page load", chartsMs: median(a.runs.map((r) => r.firstPaintMs)), settledMs: median(a.runs.map((r) => r.loadedMs)), pythonRuns: null },
   ...STEPS.map(([step], i) => ({
    step,
    chartsMs: median(a.runs.map((r) => r.steps[i].chartsMs)),
    settledMs: median(a.runs.map((r) => r.steps[i].settledMs)),
    pythonRuns: median(a.runs.map((r) => r.steps[i].pythonRuns)),
  }))]]));
// Same input must give the same numbers in every app; each is compared with the first.
const [base, ...others] = PICKED;
results.parity = others.flatMap((other) => STEPS.map(([step], i) => {
  const r = results.apps[base].runs[0].steps[i], n = results.apps[other].runs[0].steps[i];
  return { step, pair: `${base}/${other}`, kpisMatch: JSON.stringify(r.kpis) === JSON.stringify(n.kpis), [base]: r.kpis, [other]: n.kpis,
           topCustomerMatch: r.topCustomer === n.topCustomer, topCustomer: [r.topCustomer, n.topCustomer] };
}));
mkdirSync(path.join(here, "..", "qa"), { recursive: true });
const out = path.join(here, "..", "qa", `bench-${LABEL}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log("\nmedians (charts / settled ms, server round trips: Python reruns or HTTP requests):");
for (const [name, rows] of Object.entries(results.summary))
  console.log(name.padEnd(7), rows.map((r) => `${r.step}: ${r.chartsMs}/${r.settledMs} (${r.pythonRuns})`).join(" | "));
console.log("parity:", results.parity.map((p) => `${p.pair} ${p.step}: kpis ${p.kpisMatch ? "match" : "DIFFER"}, top ${p.topCustomerMatch ? "match" : "DIFFER"}`).join(" | "));
console.log("wrote", path.relative(process.cwd(), out));
