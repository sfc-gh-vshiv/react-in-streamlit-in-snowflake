// Mutation check for the jsdom tests: break one guard in kit.tsx at a time and
// confirm the suite fails. Restores kit.tsx afterwards. Not part of `npm test`.
//   node test/mutate.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIT = path.join(root, "src", "kit.tsx");
const original = readFileSync(KIT, "utf8");

const MUTANTS = [
  ["bundle swap drops the in-flight watchdog", "  if (Q.inflight) Q.timer = W.setInterval(watchdog, 1000);", "  void 0;"],
  ["no queue: a second write overwrites the first", "  if (Q.inflight) Q.queue.push({ id, action, payload });\n  else rawSend", "  rawSend"],
  ["watchdog never gives up", "  if (f.tries >= MAX_TRIES) {", "  if (false) {"],
  ["old React roots reused after a swap", "    try { h.__root?.unmount(); } catch { /* created by the previous bundle */ }\n    h.__root = undefined;", "    void 0;"],
  ["stale CSS kept", "  if (s.textContent !== css) s.textContent = css;", "  if (!s.textContent) s.textContent = css;"],
  ["responses replaced instead of merged (the template's bug)", "  const ids = Object.keys(responses || {});", "  Q.last = { ...(responses || {}) };\n  const ids = Object.keys(responses || {});"],
  ["lost answers never re-requested", "  if (!map[key] || lost(map[key])) map[key] = start();", "  if (!map[key]) map[key] = start();"],
  ["no acknowledgements", "  Q.ack = ids;", "  Q.ack = [];"],
  ["bridge input left in tab order", "    input.tabIndex = -1;", "    void 0;"],
  ["prototype keys accepted as islands", "Object.prototype.hasOwnProperty.call(islands, name) ? islands[name] : null", "(islands as Any)[name]"],
];

let missed = 0;
try {
  for (const [name, from, to] of MUTANTS) {
    if (!original.includes(from)) { console.log(`PATTERN MISSING  ${name}`); missed++; continue; }
    writeFileSync(KIT, original.replace(from, to));
    let failed = false;
    try { execFileSync(process.execPath, ["--test", "test/"], { cwd: root, stdio: "pipe", timeout: 120000 }); }
    catch { failed = true; }
    console.log(`${failed ? "caught " : "MISSED "} ${name}`);
    if (!failed) missed++;
  }
} finally {
  writeFileSync(KIT, original);
}
console.log(missed ? `${missed} mutant(s) survived` : "all mutants caught");
process.exit(missed ? 1 : 0);
