import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

/**
 * Builds the pre-bundled Claude provider.
 *
 * The daemon evaluates plugin server bundles through `eval` inside a factory
 * that only injects `require` — no `__filename`, and esbuild's CommonJS
 * conversion shims `import.meta` to `{}`. The claude-agent-sdk calls
 * `createRequire(import.meta.url)` at module scope, which would throw with an
 * undefined url. The post-patch below anchors the shim at the running
 * process's main script (`process.argv[1]`, the daemon's plugin-process
 * module): `createRequire` accepts it, and the SDK's claude-CLI resolution —
 * which resolves through the same anchor — finds the daemon's bundled copy.
 */
const OUTFILE = "server/claude-provider.dist.cjs";
const SHIM = "var import_meta = {};";
const REPLACEMENT = `var import_meta = { url: (typeof require === "function" && typeof process !== "undefined" && process.argv && process.argv[1] ? require("url").pathToFileURL(process.argv[1]) : { href: "file:///" }) };`;

await build({
  entryPoints: ["server/claude-provider.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: OUTFILE,
  external: ["@getpaseo/plugin", "@getpaseo/plugin/*"],
});

const bundled = await readFile(OUTFILE, "utf8");
if (!bundled.includes(SHIM)) {
  throw new Error(
    `esbuild no longer emits the import.meta shim (${JSON.stringify(SHIM)}); update the patch`,
  );
}
await writeFile(OUTFILE, bundled.replace(SHIM, REPLACEMENT));
console.log(`built ${OUTFILE}`);
