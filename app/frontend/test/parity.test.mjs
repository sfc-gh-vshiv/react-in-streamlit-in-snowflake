// The browser's cross-filter maths must give exactly what tpch.aggregate() gives.
// Fixture: python tests/make_parity_fixture.py (synthetic cube, 20 filter states).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, "parity_fixture.json"), "utf8"));

async function loadCubeModule() {
  const out = await build({ entryPoints: [path.join(here, "..", "src", "cube.ts")], bundle: true, write: false, format: "esm", logLevel: "silent" });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

test("cube.ts aggregate() matches tpch.aggregate() on every filter state", async () => {
  const { aggregate } = await loadCubeModule();
  assert.ok(fixture.cases.length >= 20);
  for (const { filters, expected } of fixture.cases) {
    const got = aggregate(fixture.cube, filters);
    const label = JSON.stringify(filters);
    for (const k of ["orders", "revenue", "urgent"]) assert.equal(got.kpi[k], expected.kpi[k], `${k} for ${label}`);
    for (const k of ["aov", "urgent_pct"]) assert.ok(Math.abs(got.kpi[k] - expected.kpi[k]) < 1e-9, `${k} for ${label}`);
    assert.deepEqual(got.monthly, expected.monthly, `monthly for ${label}`);
    for (const d of ["region", "nation", "segment", "priority"]) assert.deepEqual(got[d], expected[d], `${d} for ${label}`);
  }
});
