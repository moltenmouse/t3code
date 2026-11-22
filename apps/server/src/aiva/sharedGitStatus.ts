/**
 * P32 (AIV-643): with aiva.json, sessions in one checkout share its status reads. A refresh joins
 * a running read, or within the window takes the last one if HEAD hasn't moved; either leaves one
 * trailing read that publishes to every subscriber of the path. A zero window is upstream's path.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";

import { loadAivaSettings } from "./settings.ts";

export const AIVA_STATUS_REFRESH_WINDOW = Duration.seconds(5);
export const AIVA_STATUS_RETRY_DELAY = Duration.seconds(2);
const AIVA_STATUS_RETRY_MAX_DELAY = Duration.seconds(30);

export class AivaStatusRefreshWindow extends Context.Reference<() => Duration.Duration>(
  "t3/aiva/AivaStatusRefreshWindow",
  {
    defaultValue: () => () =>
      loadAivaSettings() !== null ? AIVA_STATUS_REFRESH_WINDOW : Duration.zero,
  },
) {}

interface SharedPath<A, E> {
  inFlight: Deferred.Deferred<A, E> | null;
  last: { readonly finishedAt: number; readonly value: A } | null;
  /** A caller got a read that started before it asked. */
  stale: boolean;
  trailing: boolean;
}

export function makeAivaSharedStatusRefresh<
  A extends { readonly refName: string | null },
  E,
>(options: {
  readonly window: () => Duration.Duration;
  readonly scope: Scope.Scope;
  readonly refresh: (cwd: string) => Effect.Effect<A, E>;
  readonly currentBranch: (cwd: string) => Effect.Effect<string | null, E>;
}) {
  const paths = new Map<string, SharedPath<A, E>>();
  const pathState = (cwd: string) => {
    let shared = paths.get(cwd);
    if (shared === undefined) {
      shared = { inFlight: null, last: null, stale: false, trailing: false };
      paths.set(cwd, shared);
    }
    return shared;
  };

  // The broadcaster scope owns the read, so one caller's interrupt does not cancel it for the rest.
  const start = (cwd: string, shared: SharedPath<A, E>) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const done = yield* Deferred.make<A, E>();
        const pending = shared.stale;
        shared.inFlight = done;
        shared.stale = false;
        yield* options.refresh(cwd).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              shared.inFlight = null;
              if (Exit.isSuccess(exit)) {
                shared.last = { finishedAt: yield* Clock.currentTimeMillis, value: exit.value };
              } else if (pending) {
                // A held index.lock fails a read; the catch-up it owed stays owed.
                shared.stale = true;
              }
              yield* Deferred.done(done, exit);
            }),
          ),
          Effect.forkIn(options.scope),
        );
        return done;
      }),
    );

  const trailingRead = Effect.fn("AivaSharedStatusRefresh.trailingRead")(function* (
    cwd: string,
    shared: SharedPath<A, E>,
  ) {
    shared.stale = true;
    if (shared.trailing) return;
    shared.trailing = true;
    yield* Effect.gen(function* () {
      let failures = 0;
      while (true) {
        if (shared.inFlight !== null) {
          yield* Deferred.await(shared.inFlight).pipe(Effect.ignore);
          continue;
        }
        const due =
          shared.last === null
            ? 0
            : shared.last.finishedAt +
              Duration.toMillis(options.window()) -
              (yield* Clock.currentTimeMillis);
        if (due > 0) {
          yield* Effect.sleep(Duration.millis(due));
          continue;
        }
        if (!shared.stale) break;
        const exit = yield* Effect.exit(Deferred.await(yield* start(cwd, shared)));
        if (Exit.isSuccess(exit)) {
          failures = 0;
          continue;
        }
        failures += 1;
        if (failures === 1) {
          yield* Effect.logWarning("Shared git status catch-up read failed", {
            cwdLength: cwd.length,
          });
        }
        yield* Effect.sleep(
          Duration.min(
            Duration.times(AIVA_STATUS_RETRY_DELAY, 2 ** (failures - 1)),
            AIVA_STATUS_RETRY_MAX_DELAY,
          ),
        );
      }
      shared.trailing = false;
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(options.scope));
  });

  const joinOrStart = Effect.fn("AivaSharedStatusRefresh.joinOrStart")(function* (
    cwd: string,
    shared: SharedPath<A, E>,
  ) {
    if (shared.inFlight === null) return yield* Deferred.await(yield* start(cwd, shared));
    const inFlight = shared.inFlight;
    yield* trailingRead(cwd, shared);
    return yield* Deferred.await(inFlight);
  });

  const refresh = Effect.fn("AivaSharedStatusRefresh.refresh")(function* (cwd: string) {
    const window = Duration.toMillis(options.window());
    if (window <= 0) return yield* options.refresh(cwd);
    const shared = pathState(cwd);
    const last = shared.last;
    if (
      shared.inFlight === null &&
      last !== null &&
      (yield* Clock.currentTimeMillis) - last.finishedAt < window &&
      (yield* options.currentBranch(cwd)) === last.value.refName &&
      // A read may have started while HEAD was read; join that one instead.
      shared.inFlight === null
    ) {
      yield* trailingRead(cwd, shared);
      return last.value;
    }
    return yield* joinOrStart(cwd, shared);
  });

  return { refresh };
}
