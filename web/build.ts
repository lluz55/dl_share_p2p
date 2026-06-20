import * as esbuild from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build-time signaling URL override.
// Set SIGNALING_URL env var to inject it at build time; otherwise runtime
// window.__SIGNALING_URL__ or the dev fallback in config.ts is used.
const define: Record<string, string> = {};
if (process.env.SIGNALING_URL) {
  define["__SIGNALING_URL__"] = JSON.stringify(process.env.SIGNALING_URL);
}

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: [path.join(__dirname, "src/main.ts")],
  bundle: true,
  outfile: path.join(__dirname, "dist/bundle.js"),
  format: "esm",
  target: "es2020",
  sourcemap: true,
  define,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
