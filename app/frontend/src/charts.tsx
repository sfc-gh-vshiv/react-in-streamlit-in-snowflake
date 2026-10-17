// ECharts in an island: one chart per component, re-rendered in place on every
// filter change. Only the pieces used are bundled (tree-shaken), and nothing is
// fetched at runtime.
import React, { useEffect, useRef, useState } from "react";
import { init, use, type ECharts, type EChartsCoreOption } from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { BrushComponent, GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { W } from "./kit";

use([BarChart, LineChart, BrushComponent, GridComponent, TooltipComponent, CanvasRenderer]);

// Chart instances by name, so a test harness can find a bar's position on the canvas.
export const CHARTS: Record<string, ECharts> = (W.__ibiCharts = W.__ibiCharts || {});

// Interaction-to-pixels timing for the on-screen readout: every chart reports when it
// has finished drawing the state produced by the latest input.
const timing = { t0: 0, waiting: new Set<string>(), done: (_ms: number) => {} };
export function markInput(charts: string[], done: (ms: number) => void) {
  timing.t0 = performance.now();
  timing.waiting = new Set(charts);
  timing.done = done;
}
function chartDrawn(name: string) {
  if (timing.waiting.delete(name) && timing.waiting.size === 0) timing.done(Math.round(performance.now() - timing.t0));
}

type Props = {
  name: string;
  option: EChartsCoreOption;
  height: number;
  onEvent?: (type: "click" | "brushEnd", e: any) => void;
  setup?: (chart: ECharts) => void;
  className?: string;
};

export function EChart({ name, option, height, onEvent, setup, className }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const seq = useRef(0);

  useEffect(() => {
    const c = init(el.current!, undefined, { renderer: "canvas" });
    chart.current = c;
    CHARTS[name] = c;
    c.on("click", (e) => handler.current?.("click", e));
    c.on("brushEnd", (e) => handler.current?.("brushEnd", e));
    c.on("finished", () => {
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
    const start = performance.now(), a = from.current, b = value;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 350);
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
