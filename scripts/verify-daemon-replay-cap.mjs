import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Diagnostic: proves the installed Paseo daemon imposes no count cap on
 * provider-replayed timeline items, so this plugin's replay windows
 * (server/claude-transcript.ts) are the only replay bound.
 *
 * It streams the daemon bundle (app.asar) as text and checks the timeline
 * store: `append` must not slice/splice/cap by length, and history `fetch`
 * must page from the tail with a cursor. Per-item *content* limiting
 * (`limitAgentTimelineItemContent`) is expected and unrelated to counts.
 *
 * Usage: node scripts/verify-daemon-replay-cap.mjs [--asar <path>]
 * Exit code 0 when all checks pass, 1 otherwise. Re-run after daemon
 * upgrades to confirm the bound still holds.
 */

function resolveAsar(argv) {
  const flagIndex = argv.indexOf("--asar");
  if (flagIndex !== -1 && argv[flagIndex + 1]) return argv[flagIndex + 1];
  if (process.env["PASEO_APP_ASAR"]) return process.env["PASEO_APP_ASAR"];
  const candidates =
    process.platform === "win32"
      ? [join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Paseo", "resources", "app.asar")]
      : process.platform === "darwin"
        ? ["/Applications/Paseo.app/Contents/Resources/app.asar"]
        : [join(homedir(), ".local", "share", "paseo", "resources", "app.asar")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function sanitize(window) {
  return window.replace(/[^\x20-\x7e]/g, ".");
}

function excerpt(source, marker, before = 120, after = 1600) {
  const index = source.indexOf(marker);
  if (index === -1) return null;
  return sanitize(source.slice(Math.max(0, index - before), index + after));
}

const asarPath = resolveAsar(process.argv.slice(2));
console.log(`bundle: ${asarPath}`);
const source = await readFile(asarPath, "utf8").catch((error) => {
  console.error(`cannot read bundle: ${error.message}`);
  process.exit(1);
});
console.log(`bytes: ${source.length}`);

let failed = false;
function check(name, found, predicate, detail) {
  const ok = found !== null && predicate(found);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) {
    failed = true;
    if (detail) console.log(detail.slice(0, 600));
  }
  return found;
}

const storeClass = excerpt(source, "class InMemoryAgentTimelineStore");
check("timeline store class present", storeClass, () => true);

const appendBody = excerpt(source, "append(agentId, item, options)", 0, 900);
check(
  "append has no count cap (no slice/splice/length bound)",
  appendBody,
  (body) => !/\.slice\(|\.splice\(|maxLength|maxItems|length\s*>\s*\d+/.test(body),
  appendBody,
);

const fetchBody = excerpt(source, "fetch(agentId, options)", 0, 2000);
check(
  "history fetch pages from the tail with a cursor limit",
  fetchBody,
  (body) => body.includes('"tail"') && body.includes("DEFAULT_TIMELINE_FETCH_LIMIT"),
  fetchBody,
);

const fetchLimit = source.match(/DEFAULT_TIMELINE_FETCH_LIMIT\s*=\s*(\d+)/);
check(
  "fetch page limit is a paging default, not a store cap",
  fetchLimit ? fetchLimit[0] : null,
  () => true,
);
if (fetchLimit) console.log(`fetch page size: ${fetchLimit[1]}`);

const contentLimiter = excerpt(source, "function limitAgentTimelineItemContent", 0, 300);
check(
  "per-item content limiter exists (orthogonal to item counts)",
  contentLimiter,
  () => true,
);

const projectionClass = excerpt(source, "class TimelineProjection", 0, 2600);
check(
  "projection merges rows but never drops them by count",
  projectionClass,
  (body) =>
    body.includes("mergeAssistantChunks") &&
    !/rows\.(shift|pop|splice)\(/.test(body) &&
    !/rows\.length\s*=/.test(body),
  projectionClass,
);

process.exit(failed ? 1 : 0);
