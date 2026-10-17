// Behaviour tests for the React shell, run in jsdom against a real esbuild bundle.
//   npm test
// Each "rerun" below does what Streamlit does: drop the old st.html element and
// mount the island into a fresh slot.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.tsx");

let cached;
async function bundle() {
  cached ??= (await build({
    entryPoints: [ENTRY], bundle: true, format: "iife", write: false, charset: "ascii",
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  })).outputFiles[0].text;
  return cached;
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// The bridge watchdog runs on a setInterval inside each page, so every page is
// closed even when an assertion fails; otherwise its timers keep Node alive.
const open = new Set();
after(() => { for (const w of open) w.close(); });
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);

function page(store) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("error", (...a) => errors.push(a.map(String).join(" ")));
  vc.on("jsdomError", (e) => errors.push(String(e.message || e)));
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div class="st-key-sl_bridge"><input></div></body></html>',
    { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  open.add(w);
  w.ResizeObserver = class { observe() {} disconnect() {} };
  if (store) w.__slStore = store;
  let slot = null;
  const rerun = async (props) => {
    slot?.remove();
    slot = w.document.createElement("div");
    slot.dataset.key = "app";
    w.document.body.appendChild(slot);
    w.SnowUI.mount(slot, "App", { user: "Ada", responses: {}, ...props });
    await tick();
    return slot;
  };
  const request = () => JSON.parse(w.document.querySelector(".st-key-sl_bridge input").value || "null");
  return { w, errors, rerun, request, close: () => { open.delete(w); w.close(); } };
}

test("H1: a redeployed bundle renders the app instead of blanking it", async () => {
  const code = await bundle();
  const p = page();
  p.w.eval(code);
  assert.match((await p.rerun({})).textContent, /Hello Ada/);
  p.w.eval(code);                      // a redeploy: a second bundle, with its own copy of React
  const slot = await p.rerun({});
  assert.match(slot.textContent, /Hello Ada/, "the app went blank after the bundle changed");
  assert.deepEqual(p.errors, []);
  p.close();
});

test("H1: a redeployed bundle replaces CSS left by the previous one", async () => {
  const code = await bundle();
  const p = page();
  p.w.eval(code);
  await p.rerun({});
  const css = p.w.document.getElementById("sl-css");
  assert.ok(css, "the bundle injects its CSS");
  css.textContent = "/* stale */";     // what an older deploy left in <head>
  p.w.eval(code);
  await p.rerun({});
  assert.notEqual(p.w.document.getElementById("sl-css").textContent, "/* stale */", "stale CSS survived the redeploy");
  p.close();
});

test("H2: a view keeps its result after the response leaves the props", async () => {
  const code = await bundle();
  const p = page({ section: "slow", jobs: {} });
  p.w.eval(code);
  await p.rerun({});
  const req = p.request();
  assert.equal(req?.action, "slow", "opening the view sends its request");
  let slot = await p.rerun({ responses: { [req.id]: { ok: true, result: { rows: [42] }, error: null } } });
  assert.match(slot.textContent, /42/);
  // Python stops re-sending a response once the browser has it (or when it trims old ones).
  slot = await p.rerun({ responses: {} });
  assert.doesNotMatch(slot.textContent, /Loading/, "the view fell back to Loading after its response left the props");
  assert.match(slot.textContent, /42/);
  p.close();
});

test("H2: a view whose response is gone asks again instead of waiting forever", async () => {
  const code = await bundle();
  const p = page({ section: "slow", jobs: {} });
  p.w.eval(code);
  await p.rerun({});
  const first = p.request();
  await p.rerun({ responses: { [first.id]: { ok: true, result: { rows: [42] }, error: null } } });
  p.w.__slQ.last = {};                 // the browser-side cache trimmed it too
  const slot = await p.rerun({ responses: {} });
  const again = p.request();
  assert.ok(/42/.test(slot.textContent) || (again && again.id !== first.id && again.action === "slow"),
    "the view is stuck: no result and no new request");
  p.close();
});
