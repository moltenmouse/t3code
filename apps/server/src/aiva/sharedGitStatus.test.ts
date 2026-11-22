import { assert, describe, it } from "@effect/vitest";
import type { VcsStatusLocalResult, VcsStatusStreamEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { AIVA_STATUS_REFRESH_WINDOW, AivaStatusRefreshWindow } from "./sharedGitStatus.ts";

const SESSIONS = 137;

const cleanStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/dav-impact",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

interface GitState {
  status: VcsStatusLocalResult;
  reads: number;
  beforeRead?: Effect.Effect<void> | undefined;
}

function layerFor(state: GitState, window?: Duration.Duration) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(
      Layer.merge(
        Layer.succeed(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
        ),
        Path.layer,
      ),
    ),
    Layer.provide(
      window === undefined ? Layer.empty : Layer.succeed(AivaStatusRefreshWindow, () => window),
    ),
    Layer.provide(
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.suspend(() => {
            state.reads += 1;
            const status = state.status;
            return (state.beforeRead ?? Effect.void).pipe(Effect.as(status));
          }),
        currentBranch: () => Effect.sync(() => state.status.refName),
        repositoryRoot: () => Effect.succeed("/repo"),
        invalidateLocalStatus: () => Effect.void,
        headPath: () => Effect.succeed(null),
      }),
    ),
  );
}

describe("P32 shared git status", () => {
  it.effect("sessions sharing a checkout run one git status read per refresh window", () => {
    const state: GitState = { status: cleanStatus, reads: 0 };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const published = yield* Queue.unbounded<VcsStatusStreamEvent>();
      yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.runForEach((event) => Queue.offer(published, event)),
        Effect.forkScoped({ startImmediately: true }),
      );
      assert.equal((yield* Queue.take(published))._tag, "snapshot");
      const subscriberRead = state.reads;
      // Every session in the checkout finishes a turn or asks for status while one read runs.
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeRead = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const sessions = yield* Effect.forEach(
        Array.from({ length: SESSIONS }, (_, index) => index),
        (index) =>
          index % 2 === 0
            ? broadcaster.refreshLocalStatus("/repo")
            : broadcaster.refreshStatus("/repo", { localOnly: true }),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(started);
      state.beforeRead = undefined;
      state.status = { ...cleanStatus, hasWorkingTreeChanges: true };
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(sessions);
      assert.equal(state.reads - subscriberRead, 1);

      // The read they joined started before the change, so one trailing read sends it to everyone.
      yield* TestClock.adjust(AIVA_STATUS_REFRESH_WINDOW);
      const trailing = yield* Queue.take(published);
      assert.isTrue(trailing._tag === "localUpdated" && trailing.local.hasWorkingTreeChanges);
      assert.equal(state.reads - subscriberRead, 2);

      // Sessions finishing one after another inside the window get the last read at once.
      state.status = { ...state.status, workingTree: { files: [], insertions: 5, deletions: 1 } };
      for (let index = 0; index < SESSIONS; index++) {
        const local = yield* broadcaster.refreshLocalStatus("/repo");
        assert.equal(local.refName, "feature/dav-impact");
      }
      assert.equal(state.reads - subscriberRead, 2);
      yield* TestClock.adjust(AIVA_STATUS_REFRESH_WINDOW);
      const coalesced = yield* Queue.take(published);
      assert.isTrue(
        coalesced._tag === "localUpdated" && coalesced.local.workingTree.insertions === 5,
      );
      assert.equal(state.reads - subscriberRead, 3);

      // A checkout switched inside the window is read again at once.
      state.status = { ...state.status, refName: "feature/other" };
      assert.equal((yield* broadcaster.refreshLocalStatus("/repo")).refName, "feature/other");
      assert.equal(state.reads - subscriberRead, 4);

      // Once the window has passed, a refresh reads at once.
      yield* TestClock.adjust(AIVA_STATUS_REFRESH_WINDOW);
      yield* broadcaster.refreshLocalStatus("/repo");
      assert.equal(state.reads - subscriberRead, 5);
    }).pipe(Effect.provide(layerFor(state, Duration.seconds(5))));
  });

  it.effect("without aiva.json every refresh reads git status", () => {
    const state: GitState = { status: cleanStatus, reads: 0 };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      for (let index = 0; index < 3; index++) yield* broadcaster.refreshLocalStatus("/repo");
      assert.equal(state.reads, 3);
    }).pipe(Effect.provide(layerFor(state)));
  });
});
