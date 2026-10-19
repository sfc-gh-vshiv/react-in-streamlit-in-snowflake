// Font files are inlined by esbuild as data URLs (see build.mjs).
declare module "*.woff2" { const url: string; export default url; }
