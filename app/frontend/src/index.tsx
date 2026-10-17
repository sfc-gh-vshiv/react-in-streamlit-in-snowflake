// Instant BI: cross-filtered TPC-H order analytics, computed in the browser.
// The cube arrives once per session (react_bridge.send_data); clicks never rerun Python.
// Python is asked only for the two drill-downs, which run as background queries.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Any, data, defineIslands, job, send, setStore, store, useStore, W } from "./kit";
import { CHARTS, EChart, markInput, Tween } from "./charts";
import { aggregate, allMonths, Cube, Filters, Totals } from "./cube";

declare const __SL_VERSION__: string;

const BLUE = "#29B5E8", NAVY = "#11567F", MUTED = "#94a3b8", PICKED = "#11567F";
const CHART_NAMES = ["monthly", "region", "nation", "segment", "priority"];
const DIMS = ["region", "nation", "segment", "priority"] as const;
type Dim = (typeof DIMS)[number];

const CSS = `
.sl{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0f172a}
.ibi{display:flex;flex-direction:column;gap:14px}
.ibi .top{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px}
.ibi h1{font-size:22px;margin:0;font-weight:650}
.ibi .sub{color:#64748b;font-size:13px}
.ibi .meter{margin-left:auto;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#334155;background:#f1f5f9;border-radius:8px;padding:4px 10px;white-space:nowrap}
.ibi .chips{display:flex;flex-wrap:wrap;gap:6px;min-height:28px;align-items:center}
.ibi .chip{border:1px solid #cbd5e1;background:#fff;border-radius:999px;padding:3px 10px;font:inherit;font-size:13px;cursor:pointer}
.ibi .chip:hover{border-color:${NAVY}}
.ibi .chip.clear{border:0;background:none;color:${NAVY};text-decoration:underline}
.ibi .hint{color:#94a3b8;font-size:13px}
.ibi .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.ibi .kpi{background:#f8fafc;border-radius:12px;padding:12px 14px}
.ibi .kpi .k{color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.ibi .kpi .v{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;margin-top:2px}
.ibi .grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}
.ibi .card{border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px 4px;min-width:0;position:relative;grid-column:span 3}
.ibi .card.third{grid-column:span 2}
.ibi .card h3{font-size:13px;font-weight:600;margin:0 0 4px;color:#334155}
.ibi .card.wide{grid-column:1/-1}
.ibi .card.busy .body{opacity:.45;transition:opacity .15s}
.ibi .card .state{position:absolute;top:10px;right:12px;font-size:12px;color:#64748b}
.ibi table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
.ibi th,.ibi td{text-align:left;padding:5px 8px;border-bottom:1px solid #f1f5f9;white-space:nowrap}
.ibi th.n,.ibi td.n{text-align:right}
.ibi .err{color:#b91c1c;font-size:13px}
@media (max-width:900px){.ibi .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.ibi .grid{grid-template-columns:1fr}.ibi .card,.ibi .card.third{grid-column:1/-1}}
`;

const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const money = (v: number) => "$" + (v >= 1e9 ? (v / 1e9).toFixed(1) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : int.format(v));
const pct = (v: number) => v.toFixed(1) + "%";

// ------------------------------------------------------------------ filter state
// Lives on the persistent store, so it survives reruns. An initial state can come from
// the URL (?region=EUROPE&first=12&last=35), which the tests use to compare with the twin.
function initialFilters(c: Cube): Filters {
  const f = allMonths(c);
  const q = new URLSearchParams(W.location?.search || "");
  for (const d of DIMS) if (q.get(d)) (f as Any)[d] = q.get(d);
  const n = (k: string, dflt: number) => (q.get(k) != null && !isNaN(+q.get(k)!) ? Math.max(0, Math.min(c.months.length - 1, +q.get(k)!)) : dflt);
  f.first = n("first", f.first);
  f.last = Math.max(f.first, n("last", f.last));
  return f;
}

function useFilters(c: Cube): [Filters, (f: Filters) => void] {
  const s = useStore();
  if (!s.filters) s.filters = initialFilters(c);
  const update = (f: Filters) => {
    markInput(CHART_NAMES, (ms) => setStore({ latency: ms }));
    setStore({ filters: f });
  };
  return [s.filters, update];
}

const isAll = (f: Filters, c: Cube) =>
  f.first === 0 && f.last === c.months.length - 1 && DIMS.every((d) => f[d] == null);

// ------------------------------------------------------------------ chart options
function bars(name: string, totals: Totals, picked: string | null, order?: string[], rotate = 0) {
  const keys = order ? order.filter((k) => k in totals) : Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  const values = keys.map((k) => ({
    value: totals[k],
    itemStyle: { color: picked == null || picked === k ? (picked === k ? PICKED : BLUE) : MUTED },
  }));
  return {
    animation: false,
    grid: { left: 56, right: 16, top: 8, bottom: rotate && keys.length > 8 ? 64 : 28 },
    tooltip: { trigger: "item", valueFormatter: (v: number) => money(v) },
    xAxis: { type: "category", data: keys, axisLabel: { fontSize: 10, interval: 0, rotate: keys.length > 8 ? rotate : 0, width: keys.length > 8 ? 100 : 72, overflow: "truncate" } },
    yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => money(v) }, splitLine: { lineStyle: { color: "#f1f5f9" } } },
    series: [{ name, type: "bar", data: values, barMaxWidth: 36, cursor: "pointer" }],
  };
}

function monthly(c: Cube, values: number[], f: Filters) {
  return {
    animation: false,
    grid: { left: 56, right: 16, top: 12, bottom: 28 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v) },
    xAxis: { type: "category", data: c.months, boundaryGap: false, axisLabel: { fontSize: 10 } },
    yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => money(v) }, splitLine: { lineStyle: { color: "#f1f5f9" } } },
    brush: { xAxisIndex: 0, brushType: "lineX", brushMode: "single", transformable: true, throttleType: "debounce", throttleDelay: 80,
             brushStyle: { color: "rgba(41,181,232,.12)", borderColor: BLUE } },
    series: [{
      name: "Revenue", type: "line", data: values, showSymbol: false, lineStyle: { color: NAVY, width: 2 },
      areaStyle: { color: "rgba(41,181,232,.10)" },
      markArea: f.first === 0 && f.last === c.months.length - 1 ? undefined
        : { silent: true, itemStyle: { color: "rgba(17,86,127,.06)" }, data: [[{ xAxis: c.months[f.first] }, { xAxis: c.months[f.last] }]] },
    }],
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
 *  previous one stays on screen, dimmed, so the panel never blanks or jumps. */
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
  return (
    <div className={"card" + (d.busy ? " busy" : "")} data-panel="customers" data-busy={d.busy ? "1" : "0"}>
      <h3>Top customers in the selection</h3>
      <span className="state">{d.busy ? `Querying Snowflake…${d.elapsed ? ` ${d.elapsed}s` : ""}` : ""}</span>
      <div className="body">
        {d.error ? <div className="err">{d.error}</div> : !d.shown ? <div className="hint">Loading…</div> : (
          <table>
            <thead><tr><th>Customer</th><th>Nation</th><th>Segment</th><th className="n">Orders</th><th className="n">Revenue</th></tr></thead>
            <tbody>{d.shown.map((r: Any) => (
              <tr key={r.CUSTOMER}><td>{r.CUSTOMER}</td><td>{r.NATION}</td><td>{r.SEGMENT}</td>
                <td className="n">{int.format(r.ORDERS)}</td><td className="n">{money(r.REVENUE)}</td></tr>))}
            </tbody>
          </table>)}
      </div>
    </div>
  );
}

function ShipModes({ f }: { f: Filters }) {
  const d = useDrill<Any[]>("shipmodes", f);
  const option = useMemo(() => {
    const rows = d.shown || [];
    return {
      animation: false,
      grid: { left: 70, right: 48, top: 8, bottom: 24 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => money(v) }, splitLine: { lineStyle: { color: "#f1f5f9" } } },
      yAxis: { type: "category", data: rows.map((r: Any) => r.SHIP_MODE), inverse: true, axisLabel: { fontSize: 11 } },
      series: [{ type: "bar", data: rows.map((r: Any) => r.REVENUE), itemStyle: { color: BLUE }, barMaxWidth: 22,
                 label: { show: true, position: "right", fontSize: 10, formatter: (p: Any) => `${rows[p.dataIndex]?.LATE_PCT}% late` } }],
    };
  }, [d.shown]);
  return (
    <div className={"card" + (d.busy ? " busy" : "")} data-panel="shipmodes" data-busy={d.busy ? "1" : "0"}>
      <h3>Line revenue by ship mode (6M line items)</h3>
      <span className="state">{d.busy ? `Querying Snowflake…${d.elapsed ? ` ${d.elapsed}s` : ""}` : ""}</span>
      <div className="body">{d.error ? <div className="err">{d.error}</div> : <EChart name="shipmodes" option={option} height={230} />}</div>
    </div>
  );
}

// ------------------------------------------------------------------ app
function Dashboard({ c, runs }: { c: Cube; runs: number }) {
  const s = useStore();
  const [f, setF] = useFilters(c);
  const res = useMemo(() => aggregate(c, f), [c, f]);
  const regionOrder = useMemo(() => [...new Set(c.nations.map((n) => n.region))].sort(), [c]);

  const pick = (d: Dim, v: string) => {
    const next = { ...f, [d]: f[d] === v ? null : v } as Filters;
    if (d === "region" && next.region == null) next.nation = null;       // a nation belongs to a region
    if (d === "region" && next.region && next.nation &&
        c.nations.find((n) => n.nation === next.nation)?.region !== next.region) next.nation = null;
    setF(next);
  };
  const onBar = (d: Dim) => (type: string, e: Any) => { if (type === "click" && e?.name) pick(d, e.name); };
  const onBrush = (type: string, e: Any) => {
    if (type !== "brushEnd") return;
    const range = e?.areas?.[0]?.coordRange;
    if (!range) { if (f.first !== 0 || f.last !== c.months.length - 1) setF({ ...f, first: 0, last: c.months.length - 1 }); return; }
    const first = Math.max(0, Math.round(range[0])), last = Math.min(c.months.length - 1, Math.round(range[1]));
    if (first !== f.first || last !== f.last) setF({ ...f, first, last });
  };
  // Keep the brush on the time series in step with the filter (cleared by Esc or a chip).
  const brushSetup = (chart: Any) => {
    chart.dispatchAction({ type: "takeGlobalCursor", key: "brush", brushOption: { brushType: "lineX", brushMode: "single" } });
    const whole = f.first === 0 && f.last === c.months.length - 1;
    chart.dispatchAction({ type: "brush", areas: whole ? [] : [{ brushType: "lineX", xAxisIndex: 0, coordRange: [f.first, f.last] }] });
  };
  const clear = () => setF(allMonths(c));

  useEffect(() => {
    if (W.__ibiKeys) W.removeEventListener("keydown", W.__ibiKeys);
    W.__ibiKeys = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "Escape" && !(t && /INPUT|TEXTAREA|SELECT/.test(t.tagName))) clear();
    };
    W.addEventListener("keydown", W.__ibiKeys);
  });

  const chips = [
    ...(f.first !== 0 || f.last !== c.months.length - 1 ? [["months", `${c.months[f.first]} to ${c.months[f.last]}`]] : []),
    ...DIMS.filter((d) => f[d] != null).map((d) => [d, `${d[0].toUpperCase() + d.slice(1)}: ${f[d]}`]),
  ];
  const removeChip = (k: string) => setF(k === "months" ? { ...f, first: 0, last: c.months.length - 1 }
    : k === "region" ? { ...f, region: null, nation: null } : ({ ...f, [k]: null } as Filters));

  const nations = useMemo(() => {
    const t: Totals = {};
    for (const [k, v] of Object.entries(res.nation)) t[k] = v;
    return t;
  }, [res]);

  return (
    <div className="ibi">
      <div className="top">
        <h1>Orders, 1992 to 1998</h1>
        <span className="sub">TPC-H SF1 sample data, complete months: {int.format(c.m.length)}-row order cube, filtered in the browser</span>
        <span className="meter" data-testid="meter" title="Clicks and brushing never rerun Python. Reruns come from the two drill-down queries (one per request and per poll).">
          Python reruns: <b data-runs={runs}>{runs}</b> · last update: <b data-latency={s.latency ?? ""}>{s.latency != null ? s.latency + " ms" : "–"}</b>
        </span>
      </div>
      <div className="chips">
        {chips.length ? chips.map(([k, label]) => <button key={k} className="chip" onClick={() => removeChip(k)}>{label} ×</button>)
          : <span className="hint">Click a bar or drag across the time series to filter. Esc clears.</span>}
        {!isAll(f, c) && <button className="chip clear" onClick={clear}>Clear all</button>}
      </div>
      <div className="kpis">
        <div className="kpi" data-kpi="orders"><div className="k">Orders</div><div className="v"><Tween value={res.kpi.orders} format={(v) => int.format(v)} /></div></div>
        <div className="kpi" data-kpi="revenue"><div className="k">Revenue</div><div className="v"><Tween value={res.kpi.revenue} format={money} /></div></div>
        <div className="kpi" data-kpi="aov"><div className="k">Avg order value</div><div className="v"><Tween value={res.kpi.aov} format={(v) => "$" + int.format(v)} /></div></div>
        <div className="kpi" data-kpi="urgent_pct"><div className="k">Urgent share</div><div className="v"><Tween value={res.kpi.urgent_pct} format={pct} /></div></div>
      </div>
      <div className="grid">
        <div className="card wide"><h3>Monthly revenue (drag to select a range)</h3>
          <EChart name="monthly" option={useMemo(() => monthly(c, res.monthly, f), [res, f])} height={200} onEvent={onBrush} setup={brushSetup} /></div>
        <div className="card third"><h3>Region</h3>
          <EChart name="region" option={useMemo(() => bars("Region", res.region, f.region, regionOrder), [res, f.region])} height={190} onEvent={onBar("region")} /></div>
        <div className="card third"><h3>Market segment</h3>
          <EChart name="segment" option={useMemo(() => bars("Segment", res.segment, f.segment, c.segments), [res, f.segment])} height={190} onEvent={onBar("segment")} /></div>
        <div className="card third"><h3>Order priority</h3>
          <EChart name="priority" option={useMemo(() => bars("Priority", res.priority, f.priority, c.priorities), [res, f.priority])} height={190} onEvent={onBar("priority")} /></div>
        <div className="card wide"><h3>Nation{f.region ? ` in ${f.region}` : ""}</h3>
          <EChart name="nation" option={useMemo(() => bars("Nation", nations, f.nation, undefined, 40), [nations, f.nation])} height={230} onEvent={onBar("nation")} /></div>
        <Customers f={f} />
        <ShipModes f={f} />
      </div>
    </div>
  );
}

function App(p: Any) {
  const c = data<Cube>("cube");
  if (!c) return <div className="hint">Loading the order cube…</div>;
  return <Dashboard c={c} runs={p.runs} />;
}

defineIslands({ App }, CSS, __SL_VERSION__);
W.__ibi = { CHARTS, store, version: __SL_VERSION__ };
