// P24: Codex writes some files (thread_history_1.sqlite, .sandbox_migration) straight into an
// account's shadow home, and upstream then refuses that home and switches the account off.
// With `aiva.json`, the shadow's real entries are put aside first; the shared home's never change.
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import {
  type CodexHomeLayout,
  isCodexShadowHomeOwnEntry,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { loadAivaSettings } from "./settings.ts";

const AIVA_CONFLICT_MARK = ".aiva-conflict-";
const SQLITE_SUFFIXES = [".sqlite", ".sqlite3", ".db"] as const;
const SQLITE_COMPANIONS = ["-wal", "-shm", "-journal"] as const;

function isSqliteName(name: string): boolean {
  return SQLITE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** The database a `-wal`/`-shm`/`-journal` file belongs to, if its name is one. */
function sqliteBaseOf(name: string): string | undefined {
  for (const companion of SQLITE_COMPANIONS) {
    if (name.endsWith(companion) && isSqliteName(name.slice(0, -companion.length))) {
      return name.slice(0, -companion.length);
    }
  }
  return undefined;
}

/** `20261117T063000Z` */
export function aivaConflictStamp(millis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(millis))
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

interface Context {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stamp: string;
}

type Kind = "missing" | "symlink" | "directory" | "file";

/** What is at `entryPath` itself: a symlink is never followed. */
const kindOf = Effect.fn("aiva.codexShadowHome.kindOf")(function* (
  context: Context,
  entryPath: string,
) {
  const link = yield* context.fileSystem.readLink(entryPath).pipe(Effect.option);
  if (Option.isSome(link)) return "symlink" as Kind;
  const info = yield* context.fileSystem.stat(entryPath).pipe(Effect.option);
  if (Option.isNone(info)) return "missing" as Kind;
  return (info.value.type === "Directory" ? "directory" : "file") as Kind;
});

const isCrossDevice = (error: PlatformError.PlatformError) => {
  const cause = error.reason.cause;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EXDEV";
};

const leftAcrossFilesystems = (entry: string) =>
  Effect.logWarning(
    "aiva P24: a Codex shadow home entry is on another filesystem than the shared home; left it",
    { entry },
  );

/** The names that go together with `name`: a sqlite database's side files go with it. */
const groupOf = Effect.fn("aiva.codexShadowHome.groupOf")(function* (
  context: Context,
  shadowDir: string,
  sharedDir: string,
  name: string,
) {
  const group = [name];
  if (!isSqliteName(name)) return group;
  for (const companion of SQLITE_COMPANIONS) {
    const member = `${name}${companion}`;
    const inShadow = yield* kindOf(context, context.path.join(shadowDir, member));
    const inShared = yield* kindOf(context, context.path.join(sharedDir, member));
    if (inShadow !== "missing" || inShared !== "missing") group.push(member);
  }
  return group;
});

/**
 * Whether the shared side has any of the group's names, in any form. A side file on its own also
 * counts its database: one moved next to a shared database would be read as that one's.
 */
const sharedHasAny = Effect.fn("aiva.codexShadowHome.sharedHasAny")(function* (
  context: Context,
  sharedDir: string,
  group: readonly string[],
) {
  const base = sqliteBaseOf(group[0]!);
  for (const member of base === undefined ? group : [...group, base]) {
    if ((yield* kindOf(context, context.path.join(sharedDir, member))) !== "missing") return true;
  }
  return false;
});

/**
 * Renames the group inside the shadow home to `<name>.aiva-conflict-<stamp>` (then `-2`, `-3`…),
 * each side file to `<archived name>-wal` and so on, so SQLite still reads its WAL.
 */
const archiveGroup = Effect.fn("aiva.codexShadowHome.archiveGroup")(function* (
  context: Context,
  shadowDir: string,
  group: readonly string[],
) {
  const { path } = context;
  const first = group[0]!;
  const base = path.join(shadowDir, `${first}${AIVA_CONFLICT_MARK}${context.stamp}`);
  let archive = base;
  for (let n = 2; ; n += 1) {
    let taken = false;
    for (const member of group) {
      const at = `${archive}${member.slice(first.length)}`;
      if ((yield* kindOf(context, at)) !== "missing") taken = true;
    }
    if (!taken) break;
    archive = `${base}-${n}`;
  }
  const renamed: string[] = [];
  for (const member of group) {
    const from = path.join(shadowDir, member);
    if ((yield* kindOf(context, from)) === "missing") continue;
    const to = `${archive}${member.slice(first.length)}`;
    yield* context.fileSystem.rename(from, to);
    renamed.push(to);
  }
  return renamed;
});

// Files move by a hard link then unlinking the shadow's name: unlike a rename, a link never
// replaces a shared entry that appeared meanwhile. A database and its side files move together.
const moveFiles = Effect.fn("aiva.codexShadowHome.moveFiles")(function* (
  context: Context,
  shadowDir: string,
  sharedDir: string,
  group: readonly string[],
): Effect.fn.Return<"moved" | "exists" | "crossDevice", PlatformError.PlatformError> {
  const { fileSystem, path } = context;
  const members: string[] = [];
  for (const member of group) {
    if ((yield* kindOf(context, path.join(shadowDir, member))) === "file") members.push(member);
  }
  const linked: string[] = [];
  for (const member of members) {
    const result = yield* fileSystem
      .link(path.join(shadowDir, member), path.join(sharedDir, member))
      .pipe(Effect.result);
    if (result._tag === "Success") {
      linked.push(member);
      continue;
    }
    for (const done of linked) yield* fileSystem.remove(path.join(sharedDir, done));
    if (isCrossDevice(result.failure)) return "crossDevice";
    if (result.failure.reason._tag === "AlreadyExists") return "exists";
    return yield* result.failure;
  }
  for (const member of members) yield* fileSystem.remove(path.join(shadowDir, member));
  return "moved";
});

/**
 * Moves what the shared folder lacks into it, item by item, by the same rules as the top level;
 * a symlink is moved as its link text, never followed. What the shared folder has stays.
 */
const mergeFolder = Effect.fn("aiva.codexShadowHome.mergeFolder")(function* (
  context: Context,
  shadowFolder: string,
  sharedFolder: string,
): Effect.fn.Return<void, PlatformError.PlatformError> {
  const { fileSystem, path } = context;
  const children = yield* fileSystem.readDirectory(shadowFolder);
  for (const child of children) {
    if (yield* goesWithItsDatabase(context, shadowFolder, child)) continue;
    const from = path.join(shadowFolder, child);
    const to = path.join(sharedFolder, child);
    const kind = yield* kindOf(context, from);
    const group = yield* groupOf(context, shadowFolder, sharedFolder, child);
    const sharedHas = yield* sharedHasAny(context, sharedFolder, group);
    if (kind === "symlink") {
      if (sharedHas) continue;
      const target = yield* fileSystem.readLink(from);
      const made = yield* fileSystem.symlink(target, to).pipe(Effect.result);
      if (made._tag === "Success") yield* fileSystem.remove(from);
    } else if (kind === "directory") {
      const sharedKind = yield* kindOf(context, to);
      if (sharedKind === "missing") {
        const moved = yield* fileSystem.rename(from, to).pipe(Effect.result);
        if (moved._tag === "Failure" && isCrossDevice(moved.failure)) {
          yield* leftAcrossFilesystems(from);
        } else if (moved._tag === "Failure") {
          return yield* moved.failure;
        }
      } else if (sharedKind === "directory") {
        yield* mergeFolder(context, from, to);
        if ((yield* fileSystem.readDirectory(from)).length === 0) yield* fileSystem.remove(from);
      }
    } else if (kind === "file" && !sharedHas) {
      if ((yield* moveFiles(context, shadowFolder, sharedFolder, group)) === "crossDevice") {
        yield* leftAcrossFilesystems(from);
      }
    }
  }
});

/** A side file goes with its database when that is a real file beside it. */
const goesWithItsDatabase = Effect.fn("aiva.codexShadowHome.goesWithItsDatabase")(function* (
  context: Context,
  dir: string,
  name: string,
) {
  const base = sqliteBaseOf(name);
  return base !== undefined && (yield* kindOf(context, context.path.join(dir, base))) === "file";
});

/** One real top-level entry of the shadow home (see `reconcileCodexShadowHome`). */
const reconcileEntry = Effect.fn("aiva.codexShadowHome.reconcileEntry")(function* (
  context: Context,
  shadowHome: string,
  sharedHome: string,
  name: string,
) {
  const { fileSystem, path } = context;
  const shadowPath = path.join(shadowHome, name);
  const sharedPath = path.join(sharedHome, name);
  const kind = yield* kindOf(context, shadowPath);
  if (kind === "missing" || kind === "symlink") return;
  const group = yield* groupOf(context, shadowHome, sharedHome, name);

  if (!(yield* sharedHasAny(context, sharedHome, group))) {
    const outcome =
      kind === "directory"
        ? yield* fileSystem.rename(shadowPath, sharedPath).pipe(
            Effect.as("moved" as const),
            Effect.catchIf(isCrossDevice, () => Effect.succeed("crossDevice" as const)),
          )
        : yield* moveFiles(context, shadowHome, sharedHome, group);
    if (outcome === "crossDevice") return yield* leftAcrossFilesystems(shadowPath);
    if (outcome === "moved") {
      return yield* Effect.logInfo(
        "aiva P24: moved a Codex shadow home entry into the shared home",
        {
          entry: shadowPath,
          to: sharedPath,
          with: group.slice(1),
        },
      );
    }
    // The shared home gained it meanwhile: put the shadow's aside, as below.
  }

  if (kind === "directory" && (yield* kindOf(context, sharedPath)) === "directory") {
    yield* mergeFolder(context, shadowPath, sharedPath);
    if ((yield* fileSystem.readDirectory(shadowPath)).length === 0) {
      yield* fileSystem.remove(shadowPath);
      return yield* Effect.logInfo(
        "aiva P24: merged a Codex shadow home folder into the shared home",
        {
          entry: shadowPath,
          into: sharedPath,
        },
      );
    }
  }
  const renamed = yield* archiveGroup(context, shadowHome, group);
  yield* Effect.logWarning(
    "aiva P24: the shared Codex home already has this entry; kept the shared one and renamed the shadow's",
    { entry: shadowPath, kept: sharedPath, renamed },
  );
});

// Shadow homes this t3 process has built, with or without aiva.json then. Only an account's first
// driver build reconciles, before t3 has started any Codex for it; a rebuild may overlap the old
// build's Codex, so it waits for the next start.
const seen = new Set<string>();

/**
 * Moves each real shadow entry the shared home lacks into it; renames the shadow's copy of one it
 * has to `<name>.aiva-conflict-<stamp>` (a folder after merging in what the shared one lacks).
 * Nothing already in the shared home is changed, opened or followed. Never fails.
 */
export const reconcileCodexShadowHome = Effect.fn("aiva.reconcileCodexShadowHome")(function* (
  layout: Pick<CodexHomeLayout, "mode" | "sharedHomePath" | "effectiveHomePath">,
  enabled: boolean = loadAivaSettings() !== null,
) {
  const shadowHome = layout.effectiveHomePath;
  if (layout.mode !== "authOverlay" || !shadowHome) return;
  if (seen.has(shadowHome)) {
    return yield* Effect.logDebug(
      "aiva P24: this Codex shadow home was set up when t3 started; it is checked again at the next start",
      { shadowHome },
    );
  }
  seen.add(shadowHome);
  if (!enabled) return;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realShadow = yield* fileSystem.realPath(shadowHome).pipe(Effect.option);
  if (Option.isNone(realShadow)) return;
  const realShared = yield* fileSystem
    .realPath(layout.sharedHomePath)
    .pipe(Effect.orElseSucceed(() => path.resolve(layout.sharedHomePath)));
  const within = (inner: string, outer: string) =>
    inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`);
  if (within(realShadow.value, realShared) || within(realShared, realShadow.value)) {
    return yield* Effect.logWarning(
      "aiva P24: the Codex shadow home and the shared home are the same folder or nested; left them",
      { shadowHome, sharedHome: layout.sharedHomePath, realShadow: realShadow.value, realShared },
    );
  }
  const context: Context = {
    fileSystem,
    path,
    stamp: aivaConflictStamp(yield* Clock.currentTimeMillis),
  };
  const names = yield* fileSystem
    .readDirectory(shadowHome)
    .pipe(Effect.orElseSucceed((): readonly string[] => []));
  for (const name of names) {
    if (isCodexShadowHomeOwnEntry(name) || name.includes(AIVA_CONFLICT_MARK)) continue;
    if (yield* goesWithItsDatabase(context, shadowHome, name)) continue;
    yield* reconcileEntry(context, shadowHome, layout.sharedHomePath, name).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("aiva P24: could not reconcile a Codex shadow home entry", {
          entry: path.join(shadowHome, name),
          cause,
        }),
      ),
    );
  }
});
