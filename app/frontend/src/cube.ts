// Cross-filtering over the deal cube, in the browser. This mirrors aggregate() in
// tpch.py line for line; test/parity.test.mjs checks they agree on the same cube.
export type Cube = {
  m: number[]; n: number[]; s: number[]; p: number[]; o: number[]; r: number[];
  segments: string[]; priorities: string[]; months: string[]; version: string;
  nations: { n: number; nation: string; region: string }[];
};

export type Filters = {
  first: number; last: number;
  region: string | null; nation: string | null; segment: string | null; priority: string | null;
};

export type Totals = Record<string, number>;
export type Result = {
  kpi: { orders: number; revenue: number; urgent: number; aov: number; urgent_pct: number };
  monthly: number[]; region: Totals; nation: Totals; segment: Totals; priority: Totals;
};

export const allMonths = (c: Cube): Filters =>
  ({ first: 0, last: c.months.length - 1, region: null, nation: null, segment: null, priority: null });

export function aggregate(c: Cube, f: Filters): Result {
  const nationName: string[] = [], regionOf: string[] = [];
  for (const x of c.nations) { nationName[x.n] = x.nation; regionOf[x.n] = x.region; }
  const seg = f.segment == null ? -1 : c.segments.indexOf(f.segment);
  const pri = f.priority == null ? -1 : c.priorities.indexOf(f.priority);
  const urgentIdx = c.priorities.indexOf("1-Commit");
  const monthly = new Array(c.months.length).fill(0);
  const region: Totals = {}, nation: Totals = {}, segment: Totals = {}, priority: Totals = {};
  const add = (t: Totals, k: string, v: number) => { t[k] = (t[k] || 0) + v; };
  let orders = 0, revenue = 0, urgent = 0;
  for (let i = 0; i < c.m.length; i++) {
    const m = c.m[i], n = c.n[i], s = c.s[i], p = c.p[i], r = c.r[i];
    const okM = m >= f.first && m <= f.last;
    const okR = f.region == null || regionOf[n] === f.region;
    const okN = f.nation == null || nationName[n] === f.nation;
    const okS = seg === -1 || s === seg;
    const okP = pri === -1 || p === pri;
    if (okR && okN && okS && okP) monthly[m] += r;
    if (okM && okN && okS && okP) add(region, regionOf[n], r);
    if (okM && okR && okS && okP) add(nation, nationName[n], r);
    if (okM && okR && okN && okP) add(segment, c.segments[s], r);
    if (okM && okR && okN && okS) add(priority, c.priorities[p], r);
    if (okM && okR && okN && okS && okP) {
      orders += c.o[i]; revenue += r;
      if (p === urgentIdx) urgent += c.o[i];
    }
  }
  return {
    kpi: { orders, revenue, urgent, aov: orders ? revenue / orders : 0, urgent_pct: orders ? (100 * urgent) / orders : 0 },
    monthly, region, nation, segment, priority,
  };
}
