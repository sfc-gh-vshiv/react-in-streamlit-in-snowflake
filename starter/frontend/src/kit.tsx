// The reusable half of a React-in-SiS bundle: a store that survives reruns, the
// bridge to Python, background jobs, and island mounting. App code lives in
// index.tsx and calls defineIslands() once.
import React, { useEffect, useState } from "react";
import { createRoot, Root } from "react-dom/client";

export type Any = any;
export const W = window as Any;

// ------------------------------------------------------------------ store
// Streamlit re-creates every st.html element on each rerun, so UI state lives on window.
export const store: Any = W.__slStore || (W.__slStore = {});
store.jobs = store.jobs || {};
const subs = new Set<() => void>();
export function notify() { subs.forEach((f) => f()); }
export function setStore(patch: Any) { Object.assign(store, patch); notify(); }
export function useStore(): Any {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return store;
}

// ------------------------------------------------------------------ bridge
// The hidden st.text_input holds one value, so one request is in flight at a time.
// A value written while Streamlit is mid-run can be dropped, so an unanswered
// request is re-sent with the same id; Python answers each id once.
// Responses are cached here and acknowledged, so Python can stop re-sending them.
type Req = { id: string; action: string; payload: Any };
type Inflight = Req & { t: number; tries: number };
type Queue = {
  inflight: Inflight | null; queue: Req[]; last: Record<string, Any>; size: Record<string, number>;
  ack: string[]; polls: Record<string, boolean>; backoff: Record<string, number>; reported: string; timer?: number;
};
const Q: Queue = W.__slQ || (W.__slQ = {});
// A redeployed bundle adopts the queue of the one before it, so fill in any missing fields.
Q.inflight ??= null; Q.queue ??= []; Q.last ??= {}; Q.size ??= {}; Q.ack ??= [];
Q.polls ??= {}; Q.backoff ??= {}; Q.reported ??= "";

const RETRY_MS = 6000, MAX_TRIES = 5, KEEP = 400, ACK_COUNT = 4, ACK_BYTES = 256 * 1024;

export function send(action: string, payload: Any = {}): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  if (Q.inflight) Q.queue.push({ id, action, payload });
  else rawSend({ id, action, payload });
  return id;
}

/** Merge the responses carried by this rerun's props into the browser-side cache. */
function merge(responses: Any) {
  const ids = Object.keys(responses || {});
  for (const id of ids) {
    if (!(id in Q.last)) { Q.last[id] = responses[id]; Q.size[id] = JSON.stringify(responses[id]).length; }
  }
  Q.ack = ids;                          // everything Python still sends, we already have
  const keys = Object.keys(Q.last);
  for (const id of keys.slice(0, Math.max(0, keys.length - KEEP))) { delete Q.last[id]; delete Q.size[id]; }
  if (Q.inflight && Q.inflight.id in Q.last) Q.inflight = null;
  if (!Q.inflight && Q.queue.length) { const n = Q.queue.shift()!; setTimeout(() => rawSend(n), 30); }
}

function watchdog() {
  const f = Q.inflight;
  if (!f) {
    const bytes = Q.ack.reduce((n, id) => n + (Q.size[id] || 0), 0);
    if (Q.ack.length >= ACK_COUNT || bytes >= ACK_BYTES) send("ack");
    return;
  }
  if (f.id in Q.last || Date.now() - f.t < RETRY_MS) return;
  if (f.tries >= MAX_TRIES) {           // give up: surface an error and unblock the queue
    Q.last[f.id] = { ok: false, result: null, error: "No response from the app. Please try again." };
    Q.inflight = null;
    if (Q.queue.length) { const n = Q.queue.shift()!; setTimeout(() => rawSend(n), 30); }
    notify();
    return;
  }
  f.tries++; f.t = Date.now(); write(f);
}

function rawSend(r: Req) {
  Q.inflight = { ...r, t: Date.now(), tries: 1 };
  if (!Q.timer) Q.timer = W.setInterval(watchdog, 1000);
  write(Q.inflight);
}

/** The hidden input, kept out of keyboard navigation and the accessibility tree. */
function bridgeInput(): HTMLInputElement | null {
  const input = document.querySelector(".st-key-sl_bridge input") as HTMLInputElement | null;
  if (input && input.tabIndex !== -1) {
    input.tabIndex = -1;
    input.autocomplete = "off";
    input.setAttribute("aria-hidden", "true");
    input.closest(".st-key-sl_bridge")?.setAttribute("aria-hidden", "true");
  }
  return input;
}

function assets(): Record<string, string> { return { ...(W.__slAssets || {}) }; }

function scriptRunning() {
  const s = (document.querySelector('[data-testid="stApp"]') as HTMLElement | null)?.dataset.testScriptState;
  return s === "running" || s === "rerunRequested";
}

function write(r: Inflight, waited = 0) {
  const input = bridgeInput();
  if (!input) return;                   // not rendered yet: the watchdog retries
  // A value written while a run is in progress can be lost (the watchdog exists for
  // that case), so wait, up to a few seconds, for Streamlit to finish the current run.
  if (scriptRunning() && waited < 3000) {
    setTimeout(() => { if (Q.inflight === r) write(r, waited + 50); }, 50);
    return;
  }
  r.t = Date.now();
  const msg = { v: 1, id: r.id, action: r.action, payload: r.payload, try: r.tries, ack: Q.ack.slice(0, 200), assets: assets() };
  Q.reported = JSON.stringify(msg.assets);
  // Set the value the way a user edit would, so Streamlit's input sees a change.
  // The page focus is left alone: moving it would interrupt whatever the user is typing.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, JSON.stringify(msg));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  // Streamlit's input commits on Enter by comparing against its own React state, which
  // React applies after this task. Sent in the same task, Enter sees no change and the
  // request sits unsent until the watchdog retries. A real user's Enter is a later task too.
  setTimeout(() => {
    for (const t of ["keydown", "keypress", "keyup"])
      input.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }, 0);
}

/** Tell Python which bundle and data assets this page holds, so later reruns can skip them. */
function reportAssets() {
  const a = assets();
  if (Object.keys(a).length && JSON.stringify(a) !== Q.reported && !Q.inflight && !Q.queue.length) send("ready");
}

export function response(id: string | undefined): Any { return id ? Q.last[id] : undefined; }

/** A value sent once per session with react_bridge.send_data(name, ...). */
export function data<T = Any>(name: string): T | undefined { return (W.__slData || {})[name]; }

// ------------------------------------------------------------------ jobs
export type Job<T = Any> = { loading: boolean; result: T | null; error: string | null; elapsed?: number };

function lost(id: string) {
  return !(id in Q.last) && Q.inflight?.id !== id && !Q.queue.some((r) => r.id === id);
}

/** Start once per key; poll pending results. Call it only in the component that shows
 *  the result, so slow work starts when that view opens. If the answer has gone missing
 *  (trimmed from both caches), it asks again instead of waiting forever. Each poll is a
 *  Streamlit rerun, so the interval backs off (1.5 s, 2.5 s, ... up to 5 s). */
export function job<T = Any>(key: string, start: () => string, poll = 1500): Job<T> {
  const map = store.jobs;
  if (!map[key] || lost(map[key])) map[key] = start();
  const id = map[key];
  const r = Q.last[id];
  if (!r) return { loading: true, result: null, error: null };
  if (!r.ok) return { loading: false, result: null, error: r.error };
  if (r.result && r.result.pending) {
    if (!Q.polls[id]) {
      Q.polls[id] = true;
      const n = (Q.backoff[key] = (Q.backoff[key] || 0) + 1);
      setTimeout(() => {
        if (map[key] === id) { map[key] = send("poll", { token: r.result.token }); notify(); }
      }, Math.min(5000, poll + 1000 * (n - 1)));
    }
    return { loading: true, result: null, error: null, elapsed: r.result.elapsed };
  }
  Q.backoff[key] = 0;
  return { loading: false, result: r.result, error: null };
}
export function resetJob(key: string) { delete store.jobs[key]; notify(); }

// ------------------------------------------------------------------ islands
export type Island = (props: Any) => JSX.Element;
type Host = HTMLElement & { __root?: Root };
// Keyed islands live in one persistent host that is moved into each rerun's slot, so
// React updates in place (no remount flash, no scroll jump). The slot keeps the last height.
const HOSTS: Record<string, Host> = (W.__slHosts = W.__slHosts || {});

// Every bundle carries its own copy of React. When a redeploy loads a new bundle into
// an open page, roots created by the old copy must be unmounted, not reused: the old
// React would try to render components that call the new React's hooks.
const BUNDLE_ID = Math.random().toString(36).slice(2);
function adopt() {
  if (W.__slBundleId === BUNDLE_ID) return;
  for (const h of Object.values(HOSTS)) {
    try { h.__root?.unmount(); } catch { /* created by the previous bundle */ }
    h.__root = undefined;
  }
  if (Q.timer) { W.clearInterval(Q.timer); Q.timer = undefined; }  // its watchdog runs old code
  W.__slBundleId = BUNDLE_ID;
}

function injectCss(css: string) {
  let s = document.getElementById("sl-css") as HTMLStyleElement | null;
  if (!s) { s = document.createElement("style"); s.id = "sl-css"; document.head.appendChild(s); }
  if (s.textContent !== css) s.textContent = css;   // a redeploy replaces the old CSS
}

export function defineIslands(islands: Record<string, Island>, css: string, version: string) {
  function mount(slot: Host, name: string, props: Any) {
    adopt();
    injectCss(css);
    bridgeInput();
    const C = Object.prototype.hasOwnProperty.call(islands, name) ? islands[name] : null;
    if (!C) { slot.textContent = "Unknown island: " + name; return; }
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
    merge(props?.responses);
    reportAssets();
    el.__root = el.__root || createRoot(el);
    el.__root.render(<C {...props} />);
    notify();
  }
  W.SnowUI = { mount, version };
}
