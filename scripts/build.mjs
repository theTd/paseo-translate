import { build, stop } from "esbuild";
import { closeSync, openSync } from "node:fs";
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

// The daemon renames this whole checkout into place the moment the build
// steps finish. esbuild's service process — spawned from this checkout's
// node_modules — is only detached after a build, never stopped, so its
// executable image stays locked and the daemon's rename races that lock
// (EPERM on Windows). Stop the service explicitly, then wait until the
// binary is exclusively openable: kill teardown and antivirus scans of the
// freshly extracted binary can hold the lock a moment longer. Best effort:
// past the deadline we exit anyway, leaving the original race (retryable),
// never a failed build.
stop();
if (process.platform === "win32") {
  for (const binary of [
    "node_modules/@esbuild/win32-x64/esbuild.exe",
    "node_modules/@esbuild/win32-arm64/esbuild.exe",
  ]) {
    await waitForUnlock(binary);
  }
}

console.log(`built ${OUTFILE}`);

async function waitForUnlock(relativePath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      closeSync(openSync(relativePath, "r+"));
      return;
    } catch (error) {
      // ENOENT: this architecture's esbuild binary is not installed here.
      if (error?.code === "ENOENT") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
