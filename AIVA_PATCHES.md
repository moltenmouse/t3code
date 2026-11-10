# Aiva patches on t3

This fork is upstream [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at a **stable release tag** (see `AIVA_BASE`), plus a small queue of commits titled `aiva: …`. The plan and the rules are in moltenmouse/aiva-core `docs/research/t3-fork-plan.md`.

**Rules:**
1. Our code lives in new files under `apps/server/src/aiva/`. Upstream files only get small hook calls.
2. Settings come from our own file (`~/.t3/aiva.json`). No edits to `contracts/src/settings.ts`.
3. **Off by default:** without `aiva.json`, the fork behaves exactly like upstream.
4. Patches are generic shapes we could upstream. One commit per patch. Each has its own tests.
5. No refactors, renames or formatting of upstream code.

## Branches and releases

- `aiva`: the default branch, rebased onto each new upstream stable tag.
- Releases are `v<upstream version>-aiva.<n>`, e.g. `v0.1.7-aiva.1`. Each has Linux x64 and arm64 CLI archives, `SHA256SUMS`, and the update feed files `latest-linux.yml` and `latest-linux-arm64.yml`.
- Machines install and update from `https://cloud.aiva.gg/t3/releases`, set as `T3CODE_RELEASE_BASE_URL`, plus the managed policy's update `feedUrl`. The hub serves the feed files and redirects archive downloads to these GitHub releases.
- Upstream's own workflows are disabled in this repository. Ours are `aiva-*.yml`.

## Workflows

| Workflow | What it does |
|---|---|
| `aiva-release.yml` | Builds the JS bundle once, then the CLI archive on Linux x64 and arm64 (smoke-tested), then publishes the GitHub release with checksums and feed files. Run it by hand, or push a `v*-aiva.*` tag |
| `aiva-rebase.yml` | Daily: if upstream has a newer stable tag than `AIVA_BASE`, rebases the patch queue onto it in `aiva-on-<tag>`, builds and smoke-tests it, and opens an issue with the result. Run with `promote: true` to move `aiva` to that branch and release it |

## Patches

| # | Patch | Upstream files touched | Tests | Upstream PR |
|---|---|---|---|---|
| P1, P2, P4 | **Per-thread agent extensions** from `aiva.json` (`$T3CODE_HOME/aiva.json`, or `T3CODE_AIVA_SETTINGS`): extra MCP servers with `{threadId}`/`{threadToken}` templating (P1); hidden t3 MCP tools and native sub-agents off unless allowed per thread, Codex `agents.enabled=false`, Claude `Agent` + agent teams (P2); extra env per thread, e.g. scratch `TMPDIR` (P4). Code: `apps/server/src/aiva/` | `CodexAdapterV2.ts` (wrap `codexThreadRuntimeParams`' return), `ClaudeAdapterV2.ts` (one line after `makeClaudeQueryOptions`), 1 import each | `apps/server/src/aiva/threadConfig.test.ts`; live: Codex 0.159 + gpt-6-luna (hidden tools not found, no `spawn_agent`, per-thread server + token, `TMPDIR`) | not yet |
| P3 | **Instructions:** in t3's orchestration sections, drop the sentences about hidden tools (one naming a hidden tool, and the ones after it up to the next that names another tool), a bullet left empty, and a section left with no bullets; a short table rewrites the mixed sentences worth keeping and keeps ones that stand alone, each checked against t3's text; all other text unchanged. Read at startup. Code: `packages/provider-core/src/server/aivaInstructions.ts` | `orchestrationInstructions.ts` (wrap the `T3_CODE_ORCHESTRATION_SECTIONS` array), 1 import | `aivaInstructions.test.ts` (runs over t3's real sections); live: Codex record shows the trimmed text | not yet |
| P1 (ext.) | **The thread's own t3 credential for our MCP server**: header templates `{t3McpUrl}` / `{t3McpAuthorization}`, so the sidecar calls t3's tools *as the thread* (delegation with that thread as parent) | none beyond P1's | `threadConfig.test.ts` ("t3 MCP templates"); live: Codex + luna parent → child | not yet |
| P5 | **Delegation worktree options**, passed beside `delegate_task` in `aiva-delegations/<clientRequestId>.json` (no contract change): start from the parent's uncommitted work (a snapshot commit made with a throwaway index), choose the branch name, and record the base commit; for a child on a linked machine, allow a worktree from a base commit the sidecar sent there first. Code: `apps/server/src/aiva/delegation.ts` | `OrchestratorMcpService.ts` (wrap the worktree strategy), `peer/RemoteDelegation.ts` (allow the remote worktree, pass it to the launch), 1 import each | `delegation.test.ts` (real git repo); live: local and remote worktree children on Codex + luna | not yet |
| P6 | **Webhook URLs through the Aiva hub** when T3 Connect isn't used: `webhookBaseUrl` in `aiva.json` | `scheduledTasks/ScheduledTaskService.ts` (one fallback in `webhookEndpoint`), 1 import | `threadConfig.test.ts`; live: a loop's webhook via the hub ran | not yet |
| P7 | **Continue a native conversation** (a Claude Code session or a Codex thread) in a new thread: the sidecar names it beside `t3_thread_launch` in `aiva-imports/<clientRequestId>.json` (no contract change) and puts the native file where the provider looks; the launch passes it as `importedNativeThread`. Code: `apps/server/src/aiva/imports.ts` | `mcp/toolkits/project/handlers.ts` (read the import, pass it to `launchThread`), 1 import | `imports.test.ts`; live: an Aiva session continued on node-004 | not yet |
| P8 | **Fork a sub-session with full context:** `delegate_task` takes `forkContext`; the child's provider thread is then a strong native reference to the parent's current native session, so its first turn resumes the parent's own conversation instead of starting blank. Same provider instance required. Keeps delegation's wake, stop, nesting and P5 worktree options. | `contracts` (one optional field on the MCP input and on `delegated_task.request`), `OrchestratorMcpService.ts` (same-provider check, pass the flag), `Orchestrator.ts` (emit the child's native provider thread before its first message) | existing delegation suites; live: fork of a long session on node-004 | not yet |
