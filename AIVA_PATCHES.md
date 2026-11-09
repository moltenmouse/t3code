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
| (none yet) | | | | |
