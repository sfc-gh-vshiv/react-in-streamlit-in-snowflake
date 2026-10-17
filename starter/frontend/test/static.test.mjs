// Static checks on the React source: no raw-HTML sinks, no eval, no remote fetches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = path.join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
});

const BANNED = [
  [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
  [/\.(inner|outer)HTML\s*=/, "innerHTML/outerHTML assignment"],
  [/insertAdjacentHTML/, "insertAdjacentHTML"],
  [/document\.write/, "document.write"],
  [/\beval\s*\(|new\s+Function\s*\(/, "eval / new Function"],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|import\s*\(\s*["'`]https?:/, "network call (keep the bundle self-contained; Snowflake is reached through Python)"],
];

test("H6: the React source has no raw-HTML sinks, eval or network calls", () => {
  const hits = [];
  for (const f of files(SRC)) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      for (const [re, what] of BANNED) if (re.test(line)) hits.push(`${path.relative(SRC, f)}:${i + 1} ${what}`);
    });
  }
  assert.deepEqual(hits, []);
});
