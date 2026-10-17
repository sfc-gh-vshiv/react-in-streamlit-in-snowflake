// Mutation check for the parity test: introduce plausible slips into src/cube.ts
// and confirm test/parity.test.mjs fails. Restores cube.ts. Not part of `npm test`.
//   node test/mutate.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(root, "src", "cube.ts");
const original = readFileSync(FILE, "utf8");
const MUTANTS = [
  ["time series filtered by its own month range", "    if (okR && okN && okS && okP) monthly[m] += r;", "    if (okM && okR && okN && okS && okP) monthly[m] += r;"],
  ["region chart filtered by the region filter", "    if (okM && okN && okS && okP) add(region", "    if (okM && okR && okN && okS && okP) add(region"],
  ["urgent share counts revenue, not orders", "      if (p === urgentIdx) urgent += c.o[i];", "      if (p === urgentIdx) urgent += r;"],
  ["inclusive month range made exclusive", "    const okM = m >= f.first && m <= f.last;", "    const okM = m >= f.first && m < f.last;"],
];
let missed = 0;
try {
  for (const [name, from, to] of MUTANTS) {
    if (!original.includes(from)) { console.log(`PATTERN MISSING  ${name}`); missed++; continue; }
    writeFileSync(FILE, original.replace(from, to));
    let failed = false;
    try { execFileSync(process.execPath, ["--test", "test/parity.test.mjs"], { cwd: root, stdio: "pipe", timeout: 120000 }); }
    catch { failed = true; }
    console.log(`${failed ? "caught " : "MISSED "} ${name}`);
    if (!failed) missed++;
  }
} finally {
  writeFileSync(FILE, original);
}
console.log(missed ? `${missed} mutant(s) survived` : "all mutants caught");
process.exit(missed ? 1 : 0);
