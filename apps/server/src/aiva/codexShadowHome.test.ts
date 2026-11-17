// @effect-diagnostics nodeBuiltinImport:off -- tests lay out Codex homes, databases and an aiva.json on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  CodexShadowHomeEntryConflictError,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { aivaConflictStamp, reconcileCodexShadowHome } from "./codexShadowHome.ts";

const dirs: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-codex-shadow-"));
  dirs.push(dir);
  return dir;
};
const previousSettings = process.env.T3CODE_AIVA_SETTINGS;
afterEach(() => {
  if (previousSettings === undefined) delete process.env.T3CODE_AIVA_SETTINGS;
  else process.env.T3CODE_AIVA_SETTINGS = previousSettings;
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/** A shared home, a shadow home with its own auth.json, and an aiva.json unless `aiva` is false. */
const homes = (aiva = true) => {
  const root = tempDir();
  const shared = NodePath.join(root, "codex");
  const shadow = NodePath.join(root, "accounts", "codex-account-2");
  NodeFS.mkdirSync(shared, { recursive: true });
  NodeFS.mkdirSync(shadow, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(shadow, "auth.json"), '{"account":2}\n');
  const settings = NodePath.join(root, aiva ? "aiva.json" : "missing-aiva.json");
  if (aiva) NodeFS.writeFileSync(settings, "{}");
  process.env.T3CODE_AIVA_SETTINGS = settings;
  return { root, shared, shadow, settings };
};

const write = (file: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, contents);
};

/** A WAL database whose `rows` rows are all still in its -wal, as a Codex leaves one it has open. */
const walDatabase = (file: string, rows: number) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const source = NodePath.join(tempDir(), "source.sqlite");
  const db = new NodeSqlite.DatabaseSync(source);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x)");
  for (let n = 0; n < rows; n += 1) db.prepare("INSERT INTO t VALUES (?)").run(`row ${n}`);
  NodeFS.copyFileSync(source, file);
  NodeFS.copyFileSync(`${source}-wal`, `${file}-wal`);
  db.close();
};

const rowsIn = (file: string) => {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    return (db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

/** Each file's inode and bytes, to show nothing in the shared home changed. */
const snapshot = (files: readonly string[]) =>
  files.map((file) => ({
    file,
    ino: NodeFS.lstatSync(file).ino,
    bytes: NodeFS.readFileSync(file).toString("base64"),
  }));

const layoutOf = (shared: string, shadow: string) =>
  resolveCodexHomeLayout(decodeCodexSettings({ homePath: shared, shadowHomePath: shadow }));

/** What a Codex driver build does: reconcile, then upstream's setup. */
const setUp = (shared: string, shadow: string) =>
  Effect.gen(function* () {
    const layout = yield* layoutOf(shared, shadow);
    yield* reconcileCodexShadowHome(layout);
    yield* materializeCodexShadowHome(layout);
  });

const linkTarget = (file: string) => NodeFS.readlinkSync(file);
const archivesIn = (dir: string, name: string) =>
  NodeFS.readdirSync(dir)
    .filter((entry) => entry.startsWith(`${name}.aiva-conflict-`))
    .sort();

describe("aivaConflictStamp", () => {
  it("stamps conflicts in UTC to the second", () => {
    expect(aivaConflictStamp(Date.UTC(2026, 10, 17, 6, 30, 5, 123))).toBe("20261117T063005Z");
  });
});

it.layer(NodeServices.layer)(
  "a Codex shadow home with real files where links belong (P24)",
  (it) => {
    it.effect.skipIf(!symlinksSupported)(
      "moves entries the shared home lacks into it, a database with its WAL, and links them",
      () =>
        Effect.gen(function* () {
          const { shared, shadow } = homes();
          walDatabase(NodePath.join(shadow, "thread_history_1.sqlite"), 5);
          write(NodePath.join(shadow, ".sandbox_migration"), "done\n");
          write(NodePath.join(shadow, "sessions", "2026", "a.jsonl"), "a");
          const inode = NodeFS.statSync(NodePath.join(shadow, "thread_history_1.sqlite")).ino;

          yield* setUp(shared, shadow);

          for (const name of [
            "thread_history_1.sqlite",
            "thread_history_1.sqlite-wal",
            ".sandbox_migration",
            "sessions",
          ]) {
            expect(linkTarget(NodePath.join(shadow, name))).toBe(NodePath.join(shared, name));
          }
          expect(NodeFS.statSync(NodePath.join(shared, "thread_history_1.sqlite")).ino).toBe(inode);
          expect(rowsIn(NodePath.join(shadow, "thread_history_1.sqlite"))).toBe(5);
          expect(
            NodeFS.readFileSync(NodePath.join(shared, "sessions", "2026", "a.jsonl"), "utf8"),
          ).toBe("a");
          expect(NodeFS.readFileSync(NodePath.join(shadow, "auth.json"), "utf8")).toBe(
            '{"account":2}\n',
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "never touches a shared database, even one an open writer holds, and archives the shadow's with its WAL",
      () =>
        Effect.gen(function* () {
          const { shared, shadow } = homes();
          const sharedDb = NodePath.join(shared, "thread_history_1.sqlite");
          walDatabase(sharedDb, 3);
          walDatabase(NodePath.join(shadow, "thread_history_1.sqlite"), 400);
          const writer = new NodeSqlite.DatabaseSync(sharedDb);
          try {
            writer.prepare("SELECT count(*) FROM t").get();
            const files = [sharedDb, `${sharedDb}-wal`, `${sharedDb}-shm`];
            const before = snapshot(files);

            yield* setUp(shared, shadow);

            expect(snapshot(files)).toEqual(before);
            expect(NodeFS.readdirSync(shared).some((n) => n.includes(".aiva-conflict-"))).toBe(
              false,
            );
            expect(linkTarget(NodePath.join(shadow, "thread_history_1.sqlite"))).toBe(sharedDb);
            const [archive, archiveWal] = archivesIn(shadow, "thread_history_1.sqlite");
            expect(archiveWal).toBe(`${archive}-wal`);
            // Its rows are all in the WAL: SQLite finds it only as `<archive>-wal`.
            expect(rowsIn(NodePath.join(shadow, archive!))).toBe(400);
            writer.prepare("INSERT INTO t VALUES (?)").run("written after the setup");
            expect(rowsIn(NodePath.join(shadow, "thread_history_1.sqlite"))).toBe(4);
          } finally {
            writer.close();
          }
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "keeps the shared copy of any other file and archives the shadow's",
      () =>
        Effect.gen(function* () {
          const { shared, shadow } = homes();
          const sharedConfig = NodePath.join(shared, "config.toml");
          write(sharedConfig, 'model = "shared"\n');
          write(NodePath.join(shadow, "config.toml"), 'model = "local, and newer"\n');
          const before = snapshot([sharedConfig]);

          yield* setUp(shared, shadow);

          expect(snapshot([sharedConfig])).toEqual(before);
          expect(linkTarget(NodePath.join(shadow, "config.toml"))).toBe(sharedConfig);
          const [old] = archivesIn(shadow, "config.toml");
          expect(NodeFS.readFileSync(NodePath.join(shadow, old!), "utf8")).toBe(
            'model = "local, and newer"\n',
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "merges a folder with links in it without following them, archiving what the shared one has",
      () =>
        Effect.gen(function* () {
          const { root, shared, shadow } = homes();
          const sharedSkills = NodePath.join(shared, "skills");
          const shadowSkills = NodePath.join(shadow, "skills");
          const outside = NodePath.join(root, "outside");
          write(NodePath.join(outside, "linked", "SKILL.md"), "# linked\n");
          write(NodePath.join(sharedSkills, "shared.md"), "shared");
          NodeFS.symlinkSync("../somewhere/same", NodePath.join(sharedSkills, "same"));
          write(NodePath.join(shadowSkills, "shared.md"), "shadow's copy");
          write(NodePath.join(shadowSkills, "notes.md"), "notes");
          write(NodePath.join(shadowSkills, "sub", "deep.md"), "deep");
          NodeFS.symlinkSync("../does-not-exist/mine", NodePath.join(shadowSkills, "mine"));
          NodeFS.symlinkSync(NodePath.join(outside, "linked"), NodePath.join(shadowSkills, "dir"));
          NodeFS.symlinkSync("../elsewhere/same", NodePath.join(shadowSkills, "same"));
          const before = snapshot([NodePath.join(sharedSkills, "shared.md")]);

          yield* setUp(shared, shadow);

          expect(linkTarget(shadowSkills)).toBe(sharedSkills);
          expect(snapshot([NodePath.join(sharedSkills, "shared.md")])).toEqual(before);
          expect(linkTarget(NodePath.join(sharedSkills, "same"))).toBe("../somewhere/same");
          expect(NodeFS.readFileSync(NodePath.join(sharedSkills, "notes.md"), "utf8")).toBe(
            "notes",
          );
          expect(NodeFS.readFileSync(NodePath.join(sharedSkills, "sub", "deep.md"), "utf8")).toBe(
            "deep",
          );
          // Links move as their text, dangling or not; what they lead to is left alone.
          expect(linkTarget(NodePath.join(sharedSkills, "mine"))).toBe("../does-not-exist/mine");
          expect(linkTarget(NodePath.join(sharedSkills, "dir"))).toBe(
            NodePath.join(outside, "linked"),
          );
          expect(NodeFS.readdirSync(NodePath.join(outside, "linked"))).toEqual(["SKILL.md"]);
          const [archive] = archivesIn(shadow, "skills");
          expect(NodeFS.readdirSync(NodePath.join(shadow, archive!)).sort()).toEqual([
            "same",
            "shared.md",
          ]);
          expect(linkTarget(NodePath.join(shadow, archive!, "same"))).toBe("../elsewhere/same");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "leaves an entry alone when the shared home is on another filesystem",
      () =>
        Effect.gen(function* () {
          const { shared, shadow } = homes();
          write(NodePath.join(shadow, ".sandbox_migration"), "done\n");
          write(NodePath.join(shadow, "extra", "a.txt"), "a");
          const fs = yield* FileSystem.FileSystem;
          const crossDevice = (method: string) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method,
                cause: Object.assign(new Error("EXDEV: cross-device link not permitted"), {
                  code: "EXDEV",
                }),
              }),
            );
          const otherFilesystem = FileSystem.FileSystem.of({
            ...fs,
            link: () => crossDevice("link"),
            rename: (from, to) =>
              from.startsWith(shadow) && to.startsWith(shared)
                ? crossDevice("rename")
                : fs.rename(from, to),
          });
          const layout = yield* layoutOf(shared, shadow);

          yield* reconcileCodexShadowHome(layout).pipe(
            Effect.provideService(FileSystem.FileSystem, otherFilesystem),
          );
          // Upstream links only what the shared home has, so it is happy with them left private.
          yield* materializeCodexShadowHome(layout);

          expect(NodeFS.lstatSync(NodePath.join(shadow, ".sandbox_migration")).isFile()).toBe(true);
          expect(NodeFS.readFileSync(NodePath.join(shadow, "extra", "a.txt"), "utf8")).toBe("a");
          expect(NodeFS.existsSync(NodePath.join(shared, ".sandbox_migration"))).toBe(false);
          expect(NodeFS.existsSync(NodePath.join(shared, "extra"))).toBe(false);
          expect(NodeFS.readdirSync(shadow).some((n) => n.includes(".aiva-conflict-"))).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "reconciles a shadow home only at its first build in this t3, never during a rebuild",
      () =>
        Effect.gen(function* () {
          const { shared, shadow } = homes();
          const layout = yield* layoutOf(shared, shadow);
          yield* reconcileCodexShadowHome(layout);
          write(NodePath.join(shadow, "thread_history_2.sqlite"), "written by the running Codex");

          yield* reconcileCodexShadowHome(layout);

          expect(NodeFS.lstatSync(NodePath.join(shadow, "thread_history_2.sqlite")).isFile()).toBe(
            true,
          );
          expect(NodeFS.existsSync(NodePath.join(shared, "thread_history_2.sqlite"))).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "never reconciles a shadow home that is the shared home under another name, or nested in it",
      () =>
        Effect.gen(function* () {
          const { root, shared } = homes();
          write(NodePath.join(shared, "config.toml"), 'model = "shared"\n');
          walDatabase(NodePath.join(shared, "thread_history_1.sqlite"), 3);
          const files = [
            "config.toml",
            "thread_history_1.sqlite",
            "thread_history_1.sqlite-wal",
          ].map((name) => NodePath.join(shared, name));
          const before = snapshot(files);
          const alias = NodePath.join(root, "alias");
          NodeFS.symlinkSync(shared, alias);
          const inside = NodePath.join(shared, "accounts", "codex-account-3");
          write(NodePath.join(inside, "config.toml"), "inside");
          // A shadow home holding the shared one: the shared home's own folder is inside it.
          const outer = NodePath.join(root, "outer");
          write(NodePath.join(outer, "config.toml"), "outer");
          write(NodePath.join(outer, "codex", "config.toml"), "outer's shared");

          for (const [sharedHome, shadowHome] of [
            [shared, alias],
            [alias, shared],
            [shared, inside],
            [NodePath.join(outer, "codex"), outer],
            [NodePath.join(alias, "..", "outer", "codex"), outer],
          ] as const) {
            yield* reconcileCodexShadowHome(yield* layoutOf(sharedHome, shadowHome));
          }

          expect(snapshot(files)).toEqual(before);
          expect(NodeFS.readdirSync(shared).sort()).toEqual([
            "accounts",
            "config.toml",
            "thread_history_1.sqlite",
            "thread_history_1.sqlite-wal",
          ]);
          expect(NodeFS.readFileSync(NodePath.join(inside, "config.toml"), "utf8")).toBe("inside");
          expect(NodeFS.readdirSync(outer).sort()).toEqual(["codex", "config.toml"]);
          expect(NodeFS.readdirSync(NodePath.join(outer, "codex"))).toEqual(["config.toml"]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "a shadow home first built without aiva.json isn't reconciled once aiva.json appears",
      () =>
        Effect.gen(function* () {
          const { shared, shadow, settings } = homes(false);
          const layout = yield* layoutOf(shared, shadow);
          yield* reconcileCodexShadowHome(layout);
          // The sidecar writes aiva.json while this account's Codex runs; then the instance is rebuilt.
          NodeFS.writeFileSync(settings, "{}");
          write(NodePath.join(shadow, "thread_history_2.sqlite"), "written by the running Codex");

          yield* reconcileCodexShadowHome(layout);

          expect(NodeFS.lstatSync(NodePath.join(shadow, "thread_history_2.sqlite")).isFile()).toBe(
            true,
          );
          expect(NodeFS.existsSync(NodePath.join(shared, "thread_history_2.sqlite"))).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)("without aiva.json, upstream still refuses the home", () =>
      Effect.gen(function* () {
        const { shared, shadow } = homes(false);
        write(NodePath.join(shared, "thread_history_1.sqlite"), "shared");
        write(NodePath.join(shadow, "thread_history_1.sqlite"), "shadow");

        const error = yield* setUp(shared, shadow).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomeEntryConflictError);
        expect(NodeFS.readFileSync(NodePath.join(shadow, "thread_history_1.sqlite"), "utf8")).toBe(
          "shadow",
        );
      }),
    );
  },
);
