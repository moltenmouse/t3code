// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
// Aiva fork: without T3CODE_HOME the fork reads `~/.t3/aiva.json` (apps/server/src/aiva/settings.ts,
// packages/provider-core/src/server/aivaInstructions.ts). Where the Aiva sidecar runs, that file
// exists, and its extra MCP servers, hidden tools and approvals change what tests see: the Codex
// replay tests, for one, send an unexpected `thread/start` and wait until they time out. Point the
// settings at a file that never exists, so tests run as upstream's do; a test that needs settings
// sets T3CODE_AIVA_SETTINGS itself. Listed after providerEnv.ts, which removes T3CODE_* variables.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

if (process.env.T3CODE_TEST_KEEP_PROVIDER_ENV !== "1") {
  process.env.T3CODE_AIVA_SETTINGS = NodePath.join(
    NodeOS.tmpdir(),
    `t3-test-no-aiva-${NodeCrypto.randomUUID()}`,
    "aiva.json",
  );
}
