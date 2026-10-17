// A hello-world React-in-SiS app: a landing view and one slow query run as a
// background job. Built to ../ui/sl_ui.js by `npm run build`.
import React from "react";
import { Any, defineIslands, job, send, setStore, useStore } from "./kit";

declare const __SL_VERSION__: string;

const CSS = `
.sl{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a}
.sl .nav{display:flex;gap:4px;overflow-x:auto;max-width:100%;margin-bottom:16px}
.sl .nav button{border:0;background:#f1f5f9;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
.sl .nav button.on{background:#fff;box-shadow:0 1px 3px #0002;font-weight:600}
.sl .muted{color:#64748b}
.sl .err{color:#b91c1c}
.sl pre{background:#f8fafc;border-radius:8px;padding:12px;overflow:auto}
`;

const SECTIONS = [{ id: "home", label: "Home" }, { id: "slow", label: "Slow data" }];

function SlowView() {
  const j = job("slow", () => send("slow"));
  if (j.loading) return <div className="muted">Loading…{j.elapsed ? ` ${j.elapsed}s` : ""}</div>;
  if (j.error) return <div className="err">{j.error}</div>;
  return <pre>{JSON.stringify(j.result, null, 2)}</pre>;
}

function App(p: Any) {
  const s = useStore();
  const section = s.section || "home";
  return (
    <>
      <div className="nav">{SECTIONS.map((x) =>
        <button key={x.id} className={section === x.id ? "on" : ""} onClick={() => setStore({ section: x.id })}>{x.label}</button>)}</div>
      {section === "home" ? <div>Hello {p.user}!</div> : <SlowView />}
    </>
  );
}

defineIslands({ App }, CSS, __SL_VERSION__);
