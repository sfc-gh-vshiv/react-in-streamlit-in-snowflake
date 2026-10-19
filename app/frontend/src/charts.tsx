// ECharts in an island: one chart per component, re-rendered in place on every
// filter change. Only the pieces used are bundled (tree-shaken), and nothing is
// fetched at runtime.
import React, { useEffect, useRef, useState } from "react";
import { init, registerTheme, use, type ECharts, type EChartsCoreOption } from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { BrushComponent, GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { W } from "./kit";

use([BarChart, LineChart, BrushComponent, GridComponent, TooltipComponent, CanvasRenderer]);

// One theme for every chart: the app's font, quiet axes, and a dark rounded tooltip.
export const FONT = "'Roboto Condensed Variable', system-ui, -apple-system, sans-serif";
export const INK = "#0f172a", MUTE = "#64748b", LINE = "#e2e8f0", GRID = "#eef2f7";
const axis = { axisLine: { lineStyle: { color: LINE } }, axisTick: { show: false }, axisLabel: { color: MUTE, fontSize: 11 }, splitLine: { show: false } };
registerTheme("ibi", {
  backgroundColor: "transparent",
  textStyle: { fontFamily: FONT, color: INK },
  tooltip: {
    backgroundColor: "rgba(15,23,42,.92)", borderWidth: 0, padding: [8, 12],
    textStyle: { color: "#f8fafc", fontFamily: FONT, fontSize: 12.5 },
    extraCssText: "border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.28)",
    axisPointer: { lineStyle: { color: "#94a3b8", type: "dashed" } },
  },
  categoryAxis: axis,
  valueAxis: { ...axis, axisLine: { show: false }, splitLine: { lineStyle: { color: GRID } } },
  bar: { itemStyle: { borderRadius: [5, 5, 0, 0] } },
  line: { symbol: "circle", symbolSize: 5, smooth: 0.3, lineStyle: { width: 2.4 } },
});

// Chart instances by name, so a test harness can find a bar's position on the canvas.
export const CHARTS: Record<string, ECharts> = (W.__ibiCharts = W.__ibiCharts || {});

/** Users who ask their OS for less motion get instant charts and numbers. */
export const REDUCED_MOTION: boolean = !!W.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
export const MOTION_MS = 250;
export const MOTION = REDUCED_MOTION
  ? { animation: false }
  : { animation: true, animationDuration: 0, animationDurationUpdate: MOTION_MS, animationEasingUpdate: "cubicOut" };

// Input-to-response timing for the on-screen readout. Every chart given a new option
// after an input reports its first drawn frame; once React has committed the input
// and all of those charts have drawn, the time is reported. With motion on, that is
// when the transition starts; with reduced motion, it is the final picture.
const timing = { t0: 0, armed: false, committed: false, pending: new Set<string>(), done: (_ms: number) => {} };
export function markInput(done: (ms: number) => void) {
  Object.assign(timing, { t0: performance.now(), armed: true, committed: false, pending: new Set<string>(), done });
}
function report() {
  if (!timing.armed) return;
  timing.armed = false;
  timing.done(Math.round(performance.now() - timing.t0));
}
/** Call after the commit that follows markInput (from the parent's effect). */
export function inputCommitted() {
  if (!timing.armed || timing.committed) return;
  timing.committed = true;
  if (timing.pending.size === 0) report();
}
function chartDrawn(name: string) {
  if (timing.pending.delete(name) && timing.committed && timing.pending.size === 0) report();
}

export type ChartEvent = "click" | "brush" | "brushEnd" | "over" | "out";
type Props = {
  name: string;
  option: EChartsCoreOption;
  height: number;
  onEvent?: (type: ChartEvent, e: any) => void;
  setup?: (chart: ECharts) => void;
  className?: string;
};

export function EChart({ name, option, height, onEvent, setup, className }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const seq = useRef(0);
  const drawing = useRef(false);

  useEffect(() => {
    const c = init(el.current!, "ibi", { renderer: "canvas" });
    chart.current = c;
    CHARTS[name] = c;
    c.on("click", (e) => handler.current?.("click", e));
    c.on("brush", (e) => handler.current?.("brush", e));
    c.on("brushEnd", (e) => handler.current?.("brushEnd", e));
    c.on("mouseover", (e) => handler.current?.("over", e));
    c.on("mouseout", (e) => handler.current?.("out", e));
    c.on("globalout", (e) => handler.current?.("out", e));
    // The first frame drawn after a new option: the new state is on screen.
    c.on("rendered", () => {
      if (!drawing.current) return;
      drawing.current = false;
      el.current?.setAttribute("data-render-seq", String(seq.current));
      chartDrawn(name);
    });
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current!);
    return () => { ro.disconnect(); c.dispose(); delete CHARTS[name]; chart.current = null; };
  }, [name]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    seq.current++;
    drawing.current = true;
    if (timing.armed && !timing.committed) timing.pending.add(name);
    c.setOption(option, { lazyUpdate: false });
    setup?.(c);
  }, [option]);

  return <div ref={el} className={className || "chart"} style={{ height }} data-chart={name} data-render-seq="0" />;
}

/** A number that eases to its new value instead of jumping. */
export function Tween({ value, format }: { value: number; format: (v: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (REDUCED_MOTION) { from.current = value; setShown(value); return; }
    const start = performance.now(), a = from.current, b = value;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / MOTION_MS);
      const v = a + (b - a) * (1 - Math.pow(1 - k, 3));
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span data-value={value}>{format(shown)}</span>;
}
