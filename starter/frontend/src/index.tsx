// React-in-SiS shell. Built to ../ui/sl_ui.js and injected by react_bridge.load_bundle().
import React, { useEffect, useState } from "react";
import { createRoot, Root } from "react-dom/client";

type Any = any;
const W = window as Any;

// ------------------------------------------------------------ persistent store
// Streamlit re-creates the st.html element on every rerun: keep UI state on window.
type Store = { section: string; jobs: Record<string, string> };
const store: Store = W.__slStore || (W.__slStore = { section: "home", jobs: {} });
const subs = new Set<() => void>();
export function setStore(patch: Partial<Store>) { Object.assign(store, patch); subs.forEach((f) => f()); }
export function useStore(): Store {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return store;
}

// ------------------------------------------------------------ bridge
// One request in flight: the hidden input holds a single value.
// A value written while Streamlit is mid-run can be dropped silently, so an
// unanswered request is re-sent (same id; Python dedupes ids) every RETRY_MS.
type Req = { id: string; action: string; payload: Any };
type Q = { inflight: (Req & { t: number; tries: number }) | null; queue: Req[]; polls: Record<string, boolean>; last: Any; timer?: number };
const Q: Q = W.__slQ || (W.__slQ = { inflight: null, queue: [], polls: {}, last: {} });
const RETRY_MS = 6000, MAX_TRIES = 5;
export function send(action: string, payload: Any): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  if (Q.inflight) Q.queue.push({ id, action, payload });
  else rawSend({ id, action, payload });
  return id;
}
function flushQueue(responses: Any) {
  Q.last = responses || {};
  if (Q.inflight && Q.last[Q.inflight.id]) Q.inflight = null;
  if (!Q.inflight && Q.queue.length) { const n = Q.queue.shift()!; setTimeout(() => rawSend(n), 30); }
}
function watchdog() {
  const f = Q.inflight;
  if (!f || Q.last[f.id] || Date.now() - f.t < RETRY_MS) return;
  if (f.tries >= MAX_TRIES) {          // give up: surface an error and unblock the queue
    Q.last[f.id] = { ok: false, error: "No response from the app, please retry." };
    Q.inflight = null; flushQueue(Q.last); subs.forEach((g) => g());
    return;
  }
  f.tries++; f.t = Date.now(); write(f);
}
function rawSend(r: Req) {
  Q.inflight = { ...r, t: Date.now(), tries: 1 };
  if (!Q.timer) Q.timer = W.setInterval(watchdog, 1000);
  write(Q.inflight);
}
function write(r: Req & { tries?: number }) {
  const input = document.querySelector(".st-key-sl_bridge input") as HTMLInputElement | null;
  if (!input) return;                  // not rendered yet: the watchdog retries
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const active = document.activeElement as HTMLElement | null;
  input.focus();
  // "try" changes the input value so Streamlit sees an edit; Python dedupes on id.
  setter.call(input, JSON.stringify({ id: r.id, action: r.action, payload: r.payload, try: r.tries || 1 }));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  for (const t of ["keydown", "keypress", "keyup"])
    input.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  input.blur();
  active?.focus?.();
}

// Background jobs: Python answers {pending, token} at once; poll until the result lands.
// Call this only in the component that shows the result, so work starts when that view opens.
export type Job = { loading: boolean; result: Any; error: string | null };
export function job(map: Record<string, string>, key: string, p: Any, start: () => string, poll = 1500): Job {
  if (!map[key]) map[key] = start();
  const id = map[key];
  const r = (p.responses || {})[id] || Q.last[id];
  if (!r) return { loading: true, result: null, error: null };
  if (!r.ok) return { loading: false, result: null, error: r.error };
  if (r.result && r.result.pending) {
    if (!Q.polls[id]) {
      Q.polls[id] = true;
      setTimeout(() => { if (map[key] === id) map[key] = send("poll", { token: r.result.token }); }, poll);
    }
    return { loading: true, result: null, error: null };
  }
  return { loading: false, result: r.result, error: null };
}

// ------------------------------------------------------------ app
const CSS = `
.sl{font-family:system-ui,-apple-system,sans-serif;color:#0f172a}
.sl .nav{display:flex;gap:4px;overflow-x:auto;max-width:100%;margin-bottom:16px}
.sl .nav button{border:0;background:#f1f5f9;border-radius:8px;padding:6px 12px;cursor:pointer}
.sl .nav button.on{background:#fff;box-shadow:0 1px 3px #0002;font-weight:600}
`;
function injectCss() {
  if (document.getElementById("sl-css")) return;
  const s = document.createElement("style"); s.id = "sl-css"; s.textContent = CSS; document.head.appendChild(s);
}

const SECTIONS = [{ id: "home", label: "Home" }, { id: "slow", label: "Slow data" }];

function SlowView({ p }: { p: Any }) {
  const j = job(store.jobs, "slow:" + (p.key || ""), p, () => send("slow", {}));
  if (j.loading) return <div>Loading…</div>;
  if (j.error) return <div style={{ color: "#b91c1c" }}>{j.error}</div>;
  return <pre>{JSON.stringify(j.result, null, 2)}</pre>;
}

function App(p: Any) {
  const s = useStore();
  return (
    <>
      <div className="nav">{SECTIONS.map((x) =>
        <button key={x.id} className={s.section === x.id ? "on" : ""} onClick={() => setStore({ section: x.id })}>{x.label}</button>)}</div>
      {s.section === "home" ? <div>Hello {p.user}!</div> : <SlowView p={p} />}
    </>
  );
}

const ISLANDS: Record<string, (p: Any) => JSX.Element> = { App };

// ------------------------------------------------------------ mount
// Keyed islands live in one persistent host moved into each rerun's slot, so React
// updates in place (no remount flash, no scroll jump). The slot keeps the last height.
type Host = HTMLElement & { __root?: Root };
const HOSTS: Record<string, Host> = (W.__slHosts = W.__slHosts || {});

function mount(slot: Host, name: string, props: unknown) {
  injectCss();
  const C = ISLANDS[name];
  if (!C) { slot.textContent = "Unknown island " + name; return; }
  let el: Host = slot;
  const key = slot.dataset.key;
  if (key) {
    el = HOSTS[key];
    if (!el) {
      el = HOSTS[key] = document.createElement("div") as Host;
      el.className = "sl";
      new ResizeObserver(() => {
        if (el.offsetHeight) document.documentElement.style.setProperty(`--sl-h-${key}`, el.offsetHeight + "px");
      }).observe(el);
    }
    if (el.parentElement !== slot) slot.appendChild(el);
  }
  el.__root = el.__root || createRoot(el);
  el.__root.render(<C {...(props as object)} />);
  flushQueue((props as Any)?.responses);
}
W.SnowUI = { mount, version: "app-1" };
export {};
