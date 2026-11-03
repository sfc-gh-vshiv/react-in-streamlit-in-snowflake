// Instant BI: cross-filtered pipeline analytics (synthetic, derived from the TPC-H sample), computed in the browser.
// The cube arrives once per session (react_bridge.send_data); clicks, drags and hovers
// never rerun Python. Python is asked only for the two drill-downs, which run as
// background queries.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Any, data, defineIslands, job, send, setStore, store, useStore, W } from "./kit";
import { CHARTS, ChartEvent, EChart, FONT, INK, inputCommitted, LINE, markInput, MOTION, MUTE, Tween } from "./charts";
import ROBOTO from "@fontsource-variable/roboto-condensed/files/roboto-condensed-latin-wght-normal.woff2";
import { aggregate, allMonths, Cube, Filters, Result, Totals } from "./cube";

declare const __SL_VERSION__: string;

const DIMS = ["region", "nation", "segment", "priority"] as const;
type Dim = (typeof DIMS)[number];
const LABEL: Record<Dim, string> = { region: "Region", nation: "Country", segment: "Industry", priority: "Stage" };

// ------------------------------------------------------------------ palette
// Color carries meaning: one hue per dimension (Snowflake brand, colorblind-safe set),
// and Mid Blue for measures over time. Unpicked bars fade to a tint of their own hue.
const MEASURE = "#11567F";
const HUE: Record<Dim | "months", string> = {
  region: "#29B5E8", nation: "#29B5E8", segment: "#FF9F36", priority: "#7D44CF", months: MEASURE,
};
const mix = (hex: string, t: number, to = 255) => "#" + [1, 3, 5].map((i) =>
  Math.round(to + (parseInt(hex.slice(i, i + 2), 16) - to) * t).toString(16).padStart(2, "0")).join("");
const tint = (hex: string, t = 0.3) => mix(hex, t);      // toward white
const shade = (hex: string, t = 0.65) => mix(hex, t, 0); // toward black

const CSS = `
@font-face{font-family:'Roboto Condensed Variable';font-style:normal;font-display:swap;font-weight:100 900;src:url(${ROBOTO}) format('woff2')}
.sl{font-family:${FONT};color:${INK};--sf:#29B5E8;--sf-d:#0b76a8;--ink:${INK};--mute:${MUTE};--line:${LINE}}
.sl *{box-sizing:border-box}
.sl .mi{font-family:'Material Symbols Rounded';font-weight:normal;font-style:normal;line-height:1;letter-spacing:normal;text-transform:none;white-space:nowrap;direction:ltr;font-feature-settings:'liga';-webkit-font-smoothing:antialiased;display:inline-block;vertical-align:middle;font-size:1.15em;font-variation-settings:'FILL' 0,'wght' 450}
.ibi{display:flex;flex-direction:column;gap:16px}
.ibi .hdr{position:relative;overflow:hidden;border-radius:22px;padding:24px 28px 40px;color:#fff;display:flex;align-items:center;gap:16px;
  background:radial-gradient(800px 320px at 90% -60%,rgba(255,255,255,.28),transparent 60%),radial-gradient(600px 260px at -5% 130%,rgba(17,86,125,.55),transparent 60%),linear-gradient(120deg,#11567F,#1A8BC2 55%,#29B5E8)}
.ibi .logo{width:50px;height:50px;border-radius:15px;display:grid;place-items:center;flex:none;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.35);box-shadow:0 8px 24px rgba(8,47,73,.25)}
.ibi .logo .mi{font-size:30px;font-variation-settings:'FILL' 1,'wght' 500}
.ibi h1{margin:0;font-size:30px;line-height:1.1;font-weight:700;letter-spacing:-.02em}
.ibi .hdr .sub{margin-top:5px;font-size:13.5px;color:rgba(240,249,255,.9)}
.ibi .meter{margin-left:auto;align-self:flex-start;display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.ibi .meter span{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.4);white-space:nowrap;font-variant-numeric:tabular-nums}
.ibi .meter b{font-weight:700}
.ibi .ctl{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;margin:-42px 18px 0;position:relative;z-index:2;min-height:52px;
  background:rgba(255,255,255,.94);backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:16px;padding:9px 12px;box-shadow:0 10px 30px rgba(15,23,42,.10)}
.ibi .ctl>.mi{color:var(--sf-d);font-size:20px}
.ibi .chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;flex:1;min-width:0}
.ibi .chip{display:inline-flex;align-items:center;gap:6px;border:1px solid;border-radius:999px;padding:4px 10px 4px 9px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;color:var(--ink);transition:box-shadow .15s}
.ibi .chip:hover{box-shadow:0 2px 8px rgba(15,23,42,.12)}
.ibi .chip .x{font-size:15px;color:var(--mute)}
.ibi .chip .dot{width:8px;height:8px;border-radius:3px;display:inline-block;flex:none}
.ibi .chip.clear{margin-left:auto;border-color:var(--line);background:#fff;color:var(--sf-d)}
.ibi .hint{color:var(--mute);font-size:13px}
.ibi .hint b{color:var(--ink);font-weight:600}
.ibi .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.ibi .kpi{position:relative;border-radius:16px;padding:14px 16px;background:#fff;border:1px solid var(--line);min-width:0;transition:transform .2s,box-shadow .2s}
.ibi .kpi:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(15,23,42,.08)}
.ibi .kpi .k{font-size:11px;color:var(--mute);font-weight:600;text-transform:uppercase;letter-spacing:.07em;display:flex;gap:8px;align-items:center}
.ibi .ichip{width:28px;height:28px;border-radius:9px;display:inline-grid;place-items:center;flex:none}
.ibi .ichip .mi{font-size:18px}
.ibi .kpi .v{font-size:28px;font-weight:700;letter-spacing:-.02em;margin-top:8px;font-variant-numeric:tabular-nums;white-space:nowrap}
.ibi .kpi .ctx{font-size:12.5px;color:var(--mute);margin-top:2px;min-height:17px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ibi .kpi .ctx b{font-weight:700}
.ibi .grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:16px}
.ibi .card{border:1px solid var(--line);border-radius:18px;background:#fff;padding:14px 16px 6px;min-width:0;position:relative;grid-column:span 3}
.ibi .card.third{grid-column:span 2}
.ibi .card.wide{grid-column:1/-1}
.ibi .card .head{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.ibi .card h3{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em}
.ibi .card .cap{font-size:12px;color:var(--mute);margin-top:1px}
.ibi .card.busy .body{opacity:.45;transition:opacity .15s}
.ibi .card .state{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--sf-d);background:#eff9fe;border:1px solid #bae6fd;border-radius:999px;padding:3px 9px;white-space:nowrap}
.ibi .card .state:empty{display:none}
.ibi .spin{width:11px;height:11px;border-radius:50%;border:2px solid #bae6fd;border-top-color:var(--sf-d);animation:ibiSpin .8s linear infinite}
@keyframes ibiSpin{to{transform:rotate(360deg)}}
.ibi table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
.ibi th{text-align:left;font-weight:600;color:#334155;background:#f8fafc;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.ibi th:first-child{border-radius:10px 0 0 0}.ibi th:last-child{border-radius:0 10px 0 0}
.ibi td{padding:7px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap}
.ibi tr:hover td{background:#f8fbff}
.ibi th.n,.ibi td.n{text-align:right}
.ibi .tw{max-height:344px;overflow:auto;margin:6px -4px 10px;padding:0 4px}
.ibi thead th{position:sticky;top:0;z-index:1}
.ibi tbody th.rk{background:none;color:var(--mute);font-weight:400;width:28px;padding:7px 10px;border-bottom:1px solid #f1f5f9}
.ibi td.rev{position:relative;min-width:120px}
.ibi td.rev i{position:absolute;right:10px;top:50%;height:18px;margin-top:-9px;border-radius:5px;background:${tint(MEASURE, 0.14)}}
.ibi td.rev span{position:relative;font-weight:600}
.ibi .err{color:#b91c1c;font-size:13px}
@media (prefers-reduced-motion:reduce){.ibi .kpi,.ibi .kpi:hover{transition:none;transform:none}.ibi .spin{animation:none}}
@media (max-width:900px){.ibi .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.ibi .grid{grid-template-columns:1fr}.ibi .card,.ibi .card.third{grid-column:1/-1}.ibi .meter{display:none}}
`;

const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const money = (v: number) => "$" + (v >= 1e9 ? (v / 1e9).toFixed(1) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : int.format(v));
const count = (v: number) => (v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : int.format(v));
const pct = (v: number) => v.toFixed(1) + "%";
const Dot = ({ color }: { color: string }) => <span className="dot" style={{ background: color }} />;
/** A Material Symbols icon (the font ships with Streamlit, so nothing is loaded). */
const Icon = ({ name, style }: { name: string; style?: React.CSSProperties }) => <span className="mi" aria-hidden="true" style={style}>{name}</span>;
/** An icon on a tint of its own color. */
const Chip = ({ icon, color }: { icon: string; color: string }) => (
  <span className="ichip" style={{ background: tint(color, 0.14), color: shade(color, 0.85) }}><Icon name={icon} /></span>
);
/** A panel heading: icon chip, title, optional caption, and a status pill on the right. */
function Head({ icon, color, title, cap, state }: { icon: string; color: string; title: string; cap?: string; state?: React.ReactNode }) {
  return (
    <div className="head">
      <Chip icon={icon} color={color} />
      <div><h3>{title}</h3>{cap && <div className="cap">{cap}</div>}</div>
      <span className="state">{state}</span>
    </div>
  );
}
const querying = (busy: boolean, elapsed?: number) =>
  busy ? <><span className="spin" />Querying Snowflake{elapsed ? ` ${elapsed}s` : ""}</> : null;

// ------------------------------------------------------------------ filter state
// Lives on the persistent store, so it survives reruns.
function useFilters(c: Cube): [Filters, (f: Filters) => void] {
  const s = useStore();
  if (!s.filters) s.filters = allMonths(c);
  const update = (f: Filters) => {
    markInput((ms) => setStore({ latency: ms }));
    setStore({ filters: f });
  };
  return [s.filters, update];
}

const isAll = (f: Filters, c: Cube) =>
  f.first === 0 && f.last === c.months.length - 1 && DIMS.every((d) => f[d] == null);

// ------------------------------------------------------------------ chart options
/** What hovering a bar would look like as a filter: that member's slice, in its own hue. */
type Preview = { label: string; color: string; result: Result };

function bars(name: string, totals: Totals, picked: string | null, color: string,
              preview: { totals: Totals; color: string } | null, order?: string[], rotate = 0) {
  const keys = order ? order.filter((k) => k in totals) : Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  const values = keys.map((k) => ({
    value: totals[k],
    itemStyle: picked === k ? { color, borderColor: shade(color), borderWidth: 2 }
      : { color: picked == null ? tint(color, 0.85) : tint(color), borderWidth: 0 },
  }));
  return {
    ...MOTION,
    grid: { left: 56, right: 16, top: 8, bottom: rotate && keys.length > 8 ? 64 : 28 },
    tooltip: { trigger: "item", valueFormatter: (v: number) => money(v) },
    xAxis: { type: "category", data: keys, axisLabel: { interval: 0, rotate: keys.length > 8 ? rotate : 0, width: keys.length > 8 ? 100 : 76, overflow: "truncate" } },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => money(v) } },
    series: [
      { id: "base", name, type: "bar", data: values, barMaxWidth: 36, cursor: "pointer",
        emphasis: { focus: "none", itemStyle: { color: shade(color, 0.85) } } },
      // The hover preview: always present (empty when idle) so updates animate in place.
      { id: "preview", name: "Preview", type: "bar", silent: true, barGap: "-100%", barMaxWidth: 36, z: 3,
        data: preview ? keys.map((k) => preview.totals[k] || 0) : [],
        itemStyle: { color: preview?.color || color, opacity: 0.9 } },
    ],
  };
}

function monthly(c: Cube, values: number[], preview: Preview | null) {
  return {
    ...MOTION,
    grid: { left: 56, right: 16, top: 12, bottom: 28 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v) },
    xAxis: { type: "category", data: c.months, boundaryGap: false },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => money(v) } },
    brush: { xAxisIndex: 0, brushType: "lineX", brushMode: "single", transformable: true, throttleType: "fixRate", throttleDelay: 30,
             brushStyle: { color: "rgba(17,86,127,.10)", borderColor: MEASURE } },
    series: [
      { id: "revenue", name: "Bookings", type: "line", data: values, showSymbol: false, color: MEASURE, lineStyle: { color: MEASURE, width: 2.4 },
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [
          { offset: 0, color: "rgba(41,181,232,.32)" }, { offset: 1, color: "rgba(41,181,232,.02)" }] } } },
      { id: "preview", name: preview?.label || "Preview", type: "line", silent: true, showSymbol: false, z: 3,
        data: preview ? preview.result.monthly : [], color: preview?.color || MEASURE,
        lineStyle: { color: preview?.color || MEASURE, width: 2.4, type: "dashed" } },
    ],
  };
}

// ------------------------------------------------------------------ drill-downs
function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [key]);
  return v;
}

/** A background query that follows the filters. While a new answer is on its way the
 *  previous one stays on screen, dimmed, so the panel never blanks or jumps. It waits
 *  until the filters stop moving, so a drag sends one query, not one per frame. */
function useDrill<T>(action: string, f: Filters): { shown: T | null; busy: boolean; error: string | null; elapsed?: number } {
  const settled = useSettled(f, 250);
  const key = action + ":" + JSON.stringify(settled);
  const j = job<T>(key, () => send(action, settled));
  const last = useRef<{ key: string; value: T } | null>(null);
  if (!j.loading && !j.error && j.result != null) last.current = { key, value: j.result };
  const stale = JSON.stringify(f) !== JSON.stringify(settled);
  return { shown: last.current?.value ?? null, busy: j.loading || stale, error: j.error, elapsed: j.elapsed };
}

function Customers({ f }: { f: Filters }) {
  const d = useDrill<Any[]>("customers", f);
  const top = Math.max(1, ...(d.shown || []).map((r: Any) => r.BOOKINGS));
  return (
    <div className={"card" + (d.busy ? " busy" : "")} data-panel="customers" data-busy={d.busy ? "1" : "0"}>
      <Head icon="workspace_premium" color={MEASURE} title="Top accounts in the selection" cap="Live query on 1.5M deals" state={querying(d.busy, d.elapsed)} />
      <div className="body">
        {d.error ? <div className="err">{d.error}</div> : !d.shown ? <div className="hint">Loading…</div> : (
          <div className="tw"><table>
            <thead><tr><th></th><th>Account</th><th>Country</th><th>Industry</th><th className="n">Deals</th><th className="n">Bookings</th></tr></thead>
            <tbody>{d.shown.map((r: Any, i: number) => (
              <tr key={r.ACCOUNT}><th className="rk" scope="row">{i + 1}</th><td>{r.ACCOUNT}</td><td>{r.COUNTRY}</td>
                <td><Dot color={HUE.segment} /> {r.INDUSTRY}</td>
                <td className="n">{int.format(r.DEALS)}</td>
                <td className="n rev"><i style={{ width: `calc(${(100 * r.BOOKINGS) / top}% - 20px)` }} /><span>{money(r.BOOKINGS)}</span></td></tr>))}
            </tbody>
          </table></div>)}
      </div>
    </div>
  );
}

function ShipModes({ f }: { f: Filters }) {
  const d = useDrill<Any[]>("shipmodes", f);
  const option = useMemo(() => {
    const rows = d.shown || [];
    return {
      ...MOTION,
      grid: { left: 70, right: 48, top: 8, bottom: 24 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: { type: "value", axisLabel: { formatter: (v: number) => money(v) } },
      yAxis: { type: "category", data: rows.map((r: Any) => r.LEAD_SOURCE), inverse: true },
      series: [{ type: "bar", data: rows.map((r: Any) => r.BOOKINGS), barMaxWidth: 20,
                 itemStyle: { borderRadius: [0, 5, 5, 0], color: { type: "linear", x: 0, y: 0, x2: 1, y2: 0, colorStops: [
                   { offset: 0, color: MEASURE }, { offset: 1, color: "#29B5E8" }] } },
                 label: { show: true, position: "right", fontSize: 11, color: MUTE, formatter: (p: Any) => `${rows[p.dataIndex]?.SLIPPED_PCT}% slipped` } }],
    };
  }, [d.shown]);
  return (
    <div className={"card" + (d.busy ? " busy" : "")} data-panel="shipmodes" data-busy={d.busy ? "1" : "0"}>
      <Head icon="local_shipping" color={MEASURE} title="Booked lines by lead source" cap="Live query on 6M line items, with the slipped share" state={querying(d.busy, d.elapsed)} />
      <div className="body">{d.error ? <div className="err">{d.error}</div> : <EChart name="shipmodes" option={option} height={360} />}</div>
    </div>
  );
}

// ------------------------------------------------------------------ app
function Dashboard({ c, runs }: { c: Cube; runs: number }) {
  const s = useStore();
  const [f, setF] = useFilters(c);
  const fRef = useRef(f);
  fRef.current = f;
  const res = useMemo(() => aggregate(c, f), [c, f]);
  const all = useMemo(() => aggregate(c, allMonths(c)), [c]);
  const regionOf = useMemo(() => Object.fromEntries(c.nations.map((n) => [n.nation, n.region])), [c]);
  const regionOrder = useMemo(() => [...new Set(c.nations.map((n) => n.region))].sort(), [c]);
  const lastMonth = c.months.length - 1;

  // A nation belongs to a region: picking another region drops the nation.
  const withPick = (base: Filters, d: Dim, v: string | null): Filters => {
    const next = { ...base, [d]: v } as Filters;
    if (d === "region" && (v == null || (next.nation && regionOf[next.nation] !== v))) next.nation = null;
    return next;
  };
  const pick = (d: Dim, v: string) => setF(withPick(f, d, f[d] === v ? null : v));

  // ---- hover preview, coalesced to one update per animation frame
  const [hover, setHover] = useState<{ dim: Dim; value: string } | null>(null);
  const hoverNext = useRef<typeof hover>(null), hoverRaf = useRef(0);
  const hoverSoon = (h: typeof hover) => {
    hoverNext.current = h;
    if (!hoverRaf.current) hoverRaf.current = requestAnimationFrame(() => {
      hoverRaf.current = 0;
      const n = hoverNext.current;
      setHover((p) => (p?.dim === n?.dim && p?.value === n?.value ? p : n));
    });
  };
  const preview: Preview | null = useMemo(() => {
    if (!hover || f[hover.dim] === hover.value) return null;
    return { label: hover.value, color: HUE[hover.dim], result: aggregate(c, withPick(f, hover.dim, hover.value)) };
  }, [hover, f, c]);
  const previewFor = (d: Dim) => (preview && hover && hover.dim !== d ? { totals: preview.result[d], color: preview.color } : null);

  const onBar = (d: Dim) => (type: ChartEvent, e: Any) => {
    if (type === "click" && e?.name) pick(d, e.name);
    else if (type === "over" && e?.componentType === "series" && e.seriesIndex === 0 && e.name) hoverSoon({ dim: d, value: e.name });
    else if (type === "out") hoverSoon(null);
  };

  // ---- time series: the dashboard follows the brush while it is dragged
  const dragging = useRef(false), quiet = useRef(false);
  const liveRange = useRef<[number, number] | null>(null), liveRaf = useRef(0);
  const [, setDragDone] = useState(0);
  const toRange = (e: Any): [number, number] | null => {
    const r = e?.areas?.[0]?.coordRange;
    return r ? [Math.max(0, Math.round(r[0])), Math.min(lastMonth, Math.round(r[1]))] : null;
  };
  const applyRange = ([first, last]: [number, number]) => {
    const cur = fRef.current;
    if (first !== cur.first || last !== cur.last) setF({ ...cur, first, last });
  };
  const onBrush = (type: ChartEvent, e: Any) => {
    if (quiet.current) return;                         // our own dispatch below
    if (type === "brush") {
      const r = toRange(e);
      if (!r) return;
      dragging.current = true;
      liveRange.current = r;
      if (!liveRaf.current) liveRaf.current = requestAnimationFrame(() => {
        liveRaf.current = 0;
        if (dragging.current && liveRange.current) applyRange(liveRange.current);
      });
    } else if (type === "brushEnd") {
      dragging.current = false;
      applyRange(toRange(e) || [0, lastMonth]);
      setDragDone((n) => n + 1);                       // redraw the series once the drag ends
    }
  };
  // Keep the brush on the time series in step with the filter (cleared by Esc or a chip).
  const brushSetup = (chart: Any) => {
    const ff = fRef.current, whole = ff.first === 0 && ff.last === lastMonth;
    quiet.current = true;
    chart.dispatchAction({ type: "takeGlobalCursor", key: "brush", brushOption: { brushType: "lineX", brushMode: "single" } }, { silent: true });
    chart.dispatchAction({ type: "brush", areas: whole ? [] : [{ brushType: "lineX", xAxisIndex: 0, coordRange: [ff.first, ff.last] }] }, { silent: true });
    quiet.current = false;
  };
  // The series ignores the month filter, so it only redraws when another filter or the
  // preview changes, never mid-drag (redrawing would reset the brush under the pointer).
  const monthlyValues = useMemo(() => res.monthly, [c, f.region, f.nation, f.segment, f.priority]);
  const monthlyPreview = dragging.current ? null : preview;
  const rangeKey = useRef("");
  if (!dragging.current) rangeKey.current = `${f.first}-${f.last}`;
  const monthlyOption = useMemo(() => monthly(c, monthlyValues, monthlyPreview), [monthlyValues, monthlyPreview, rangeKey.current]);

  const clear = () => setF(allMonths(c));

  useEffect(() => inputCommitted());
  useEffect(() => {
    if (W.__ibiKeys) W.removeEventListener("keydown", W.__ibiKeys);
    W.__ibiKeys = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "Escape" && !(t && /INPUT|TEXTAREA|SELECT/.test(t.tagName))) clear();
    };
    W.addEventListener("keydown", W.__ibiKeys);
  });

  const chips: [Dim | "months", string][] = [
    ...(f.first !== 0 || f.last !== lastMonth ? [["months", `${c.months[f.first]} to ${c.months[f.last]}`] as [Dim | "months", string]] : []),
    ...DIMS.filter((d) => f[d] != null).map((d) => [d, `${LABEL[d]}: ${f[d]}`] as [Dim, string]),
  ];
  const removeChip = (k: Dim | "months") => setF(k === "months" ? { ...f, first: 0, last: lastMonth } : withPick(f, k, null));

  // ---- KPI context: share of the whole, or what the hovered member would show
  const share = (part: number, whole: number, what: string) =>
    isAll(f, c) ? `all ${what}, 2020 to 2026` : `${pct((100 * part) / (whole || 1))} of all ${what}`;
  const ctx = (now: string, pv: (r: Result) => string) => preview
    ? <span style={{ color: shade(preview.color, 0.8) }}><b>{preview.label}</b>: {pv(preview.result)}</span>
    : now;
  const k = res.kpi, a = all.kpi;
  const kpis = [
    { id: "orders", label: "Deals", icon: "receipt_long", color: "#29B5E8", value: k.orders, fmt: (v: number) => int.format(v),
      ctx: ctx(share(k.orders, a.orders, "deals"), (r) => count(r.kpi.orders) + " deals") },
    { id: "revenue", label: "Bookings", icon: "payments", color: MEASURE, value: k.revenue, fmt: money,
      ctx: ctx(share(k.revenue, a.revenue, "bookings"), (r) => money(r.kpi.revenue)) },
    { id: "aov", label: "Avg deal size", icon: "shopping_bag", color: MEASURE, value: k.aov, fmt: (v: number) => "$" + int.format(v),
      ctx: ctx(isAll(f, c) ? `per deal, across ${count(a.orders)} deals` : `vs $${int.format(a.aov)} across all deals`, (r) => "$" + int.format(r.kpi.aov)) },
    { id: "urgent_pct", label: "Commit share", icon: "priority_high", color: HUE.priority, value: k.urgent_pct, fmt: pct,
      ctx: ctx(isAll(f, c) ? "of deals are at the Commit stage" : `vs ${pct(a.urgent_pct)} across all deals`, (r) => pct(r.kpi.urgent_pct)) },
  ];

  const ICON: Record<Dim | "months", string> = { months: "monitoring", region: "public", nation: "flag", segment: "category", priority: "bolt" };
  const card = (cls: string, d: Dim | "months", title: string, cap: string, chart: React.ReactNode) => (
    <div className={"card " + cls}><Head icon={ICON[d]} color={HUE[d]} title={title} cap={cap} />{chart}</div>
  );
  const tap = "Click to filter, hover to preview";

  return (
    <div className="ibi">
      <div className="hdr">
        <div className="logo"><Icon name="bolt" /></div>
        <div>
          <h1>Instant BI</h1>
          <div className="sub">Synthetic pipeline from the TPC-H sample, 2020 to 2026 · a {int.format(c.m.length)}-row cube, filtered in your browser</div>
        </div>
        <div className="meter" data-testid="meter" title="Clicks, drags and hovers never rerun Python. Reruns come from the two drill-down queries (one per request and per poll).">
          <span><Icon name="replay" />Python reruns <b data-runs={runs}>{runs}</b></span>
          <span><Icon name="timer" />Response <b data-latency={s.latency ?? ""}>{s.latency != null ? s.latency + " ms" : "–"}</b></span>
        </div>
      </div>
      <div className="ctl">
        <Icon name="filter_alt" />
        <div className="chips">
          {chips.length ? chips.map(([key, label]) => (
            <button key={key} className="chip" onClick={() => removeChip(key)} aria-label={`Remove filter ${label}`} title="Remove this filter"
                    style={{ borderColor: tint(HUE[key], 0.6), background: tint(HUE[key], 0.12) }}>
              <Dot color={HUE[key]} />{label}<span className="mi x" aria-hidden="true">close</span>
            </button>))
            : <span className="hint"><b>Click</b> a bar to filter, <b>hover</b> to preview, <b>drag</b> across the months to pick a range. Esc clears.</span>}
          {!isAll(f, c) && <button className="chip clear" onClick={clear}>Clear all</button>}
        </div>
      </div>
      <div className="kpis">
        {kpis.map((x) => (
          <div className="kpi" data-kpi={x.id} key={x.id}
               style={{ background: `radial-gradient(320px 140px at 100% 0%, ${tint(x.color, 0.12)}, transparent 70%), #fff` }}>
            <div className="k"><Chip icon={x.icon} color={x.color} />{x.label}</div>
            <div className="v"><Tween value={x.value} format={x.fmt} /></div>
            <div className="ctx" data-ctx={x.id}>{x.ctx}</div>
          </div>))}
      </div>
      <div className="grid">
        {card("wide", "months", "Monthly bookings", "Drag across the months to pick a range; the dashboard follows as you drag",
          <EChart name="monthly" option={monthlyOption} height={200} onEvent={onBrush} setup={brushSetup} />)}
        {card("third", "region", "Region", tap,
          <EChart name="region" option={useMemo(() => bars("Region", res.region, f.region, HUE.region, previewFor("region"), regionOrder), [res, f.region, preview])} height={190} onEvent={onBar("region")} />)}
        {card("third", "segment", "Industry", tap,
          <EChart name="segment" option={useMemo(() => bars("Industry", res.segment, f.segment, HUE.segment, previewFor("segment"), c.segments), [res, f.segment, preview])} height={190} onEvent={onBar("segment")} />)}
        {card("third", "priority", "Deal stage", tap,
          <EChart name="priority" option={useMemo(() => bars("Stage", res.priority, f.priority, HUE.priority, previewFor("priority"), c.priorities), [res, f.priority, preview])} height={190} onEvent={onBar("priority")} />)}
        {card("wide", "nation", `Country${f.region ? ` in ${f.region}` : ""}`, f.region ? tap : `${tap}; pick a region to narrow the list`,
          <EChart name="nation" option={useMemo(() => bars("Country", res.nation, f.nation, HUE.nation, previewFor("nation"), undefined, 40), [res, f.nation, preview])} height={230} onEvent={onBar("nation")} />)}
        <Customers f={f} />
        <ShipModes f={f} />
      </div>
    </div>
  );
}

function App(p: Any) {
  const c = data<Cube>("cube");
  if (!c) return <div className="hint">Loading the deal cube…</div>;
  return <Dashboard c={c} runs={p.runs} />;
}

defineIslands({ App }, CSS, __SL_VERSION__);
W.__ibi = { CHARTS, store, version: __SL_VERSION__ };
