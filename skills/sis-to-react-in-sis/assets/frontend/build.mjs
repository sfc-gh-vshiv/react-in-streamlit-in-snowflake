// Build the React bundle that react_bridge.py loads: ../ui/sl_ui.js
//   npm run build
// The same options are used by the tests, so they exercise the shipped bundle.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));

export const options = {
  entryPoints: [path.join(here, "src", "index.tsx")],
  bundle: true,
  minify: true,
  format: "iife",
  charset: "ascii",          // the bundle travels base64-encoded; keep it plain ASCII
  target: "es2020",
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": '"production"',
    __SL_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: "warning",
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outfile = path.join(here, "..", "ui", "sl_ui.js");
  await build({ ...options, outfile });
  console.log(`built ${path.relative(process.cwd(), outfile)} (v${pkg.version})`);
}
