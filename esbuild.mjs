import * as esbuild from "esbuild";

// Two CJS bundles. `playwright` stays external (resolves its driver and
// browser binaries from node_modules at runtime); `vscode` is provided by the
// extension host.
await esbuild.build({
  entryPoints: ["src/server.ts", "src/extension.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["playwright", "vscode"],
  sourcemap: true,
  logLevel: "info",
});
