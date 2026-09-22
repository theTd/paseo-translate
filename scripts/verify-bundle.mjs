// Replicates the daemon's plugin evaluation: eval + factory(require) with no
// __filename and no module context, exactly like wrapCommonJsBundle +
// evaluateBundle in packages/server.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const code = await readFile("server/claude-provider.dist.cjs", "utf8");
const wrapped = `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`;
const factory = (0, eval)(wrapped);
const exports = factory((name) => nodeRequire(name));
if (typeof exports.createTranslateClaudeProvider !== "function") {
  throw new Error("bundle did not export the factory");
}
const provider = exports.createTranslateClaudeProvider({ loadConfig: async () => ({}) });
if (provider.id !== "translate-claude") {
  throw new Error(`unexpected provider id: ${provider.id}`);
}
console.log("bundle loads in the daemon evaluation shape:", provider.id);
