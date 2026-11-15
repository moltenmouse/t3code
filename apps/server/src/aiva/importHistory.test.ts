// @effect-diagnostics nodeBuiltinImport:off -- tests write real option files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  aivaCreatedAt,
  aivaHistoryEvents,
  MAX_HISTORY_MESSAGES,
  parseAivaImportExtras,
  stageAivaImportExtras,
  takeAivaImportExtras,
} from "./importHistory.ts";
import { takeAivaNativeImport } from "./imports.ts";

describe("P20 moved sessions", () => {
  it("reads the start, parent and history beside P7's import", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-imports-"));
    NodeFS.writeFileSync(
      NodePath.join(dir, "req-1.json"),
      JSON.stringify({
        nativeId: "01a0ec9c-6050-7464-bd2a-568e450c3322",
        title: "Team leader",
        createdAt: "2026-09-29T10:01:03.9236323+00:00",
        parentThreadId: "mcp:launch:abc",
        history: [
          { role: "user", text: "hi", createdAt: "2026-11-14T09:00:00Z" },
          { role: "system", text: "dropped", createdAt: "2026-11-14T09:00:00Z" },
          { role: "assistant", text: "   ", createdAt: "2026-11-14T09:00:00Z" },
          { role: "assistant", text: "no time" },
          { role: "assistant", text: "hello", createdAt: "2026-11-14T09:01:00Z" },
        ],
        omittedMessageCount: 7,
      }),
    );
    const read = takeAivaNativeImport("req-1", dir);
    expect(read?.nativeId).toBe("01a0ec9c-6050-7464-bd2a-568e450c3322");
    expect(read?.extras).toEqual({
      createdAt: "2026-09-29T10:01:03.923Z",
      parentThreadId: "mcp:launch:abc",
      history: [
        { role: "user", text: "hi", createdAt: "2026-11-14T09:00:00.000Z" },
        { role: "assistant", text: "hello", createdAt: "2026-11-14T09:01:00.000Z" },
      ],
      omittedMessageCount: 7,
    });
  });

  it("leaves a plain import as it was, and refuses bad values", () => {
    expect(parseAivaImportExtras({ nativeId: "x" })).toBeNull();
    expect(
      parseAivaImportExtras({ createdAt: "yesterday", parentThreadId: "../x", history: "no" }),
    ).toBeNull();
    const many = Array.from({ length: MAX_HISTORY_MESSAGES + 5 }, (_, i) => ({
      role: "user",
      text: `m${i}`,
      createdAt: "2026-11-14T09:00:00Z",
    }));
    const kept = parseAivaImportExtras({ history: many });
    expect(kept?.history).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(kept?.history[0]?.text).toBe("m5");
  });

  it("stages for one thread, once", () => {
    const extras = { createdAt: null, parentThreadId: null, history: [], omittedMessageCount: 0 };
    stageAivaImportExtras("t1", extras);
    expect(takeAivaImportExtras("t2")).toBeNull();
    expect(takeAivaImportExtras("t1")).toBe(extras);
    expect(takeAivaImportExtras("t1")).toBeNull();
  });

  it("keeps the earlier start only, and writes a notice then each message", () => {
    const now = DateTime.makeUnsafe("2026-11-15T10:00:00Z");
    const at = (extras: Parameters<typeof aivaCreatedAt>[0]) =>
      DateTime.formatIso(aivaCreatedAt(extras, now));
    const base = { parentThreadId: null, history: [], omittedMessageCount: 0 };
    expect(at(null)).toBe("2026-11-15T10:00:00.000Z");
    expect(at({ ...base, createdAt: "2026-09-29T10:00:00.000Z" })).toBe("2026-09-29T10:00:00.000Z");
    expect(at({ ...base, createdAt: "2027-01-01T00:00:00.000Z" })).toBe("2026-11-15T10:00:00.000Z");

    const events = aivaHistoryEvents(
      ThreadId.make("t"),
      {
        ...base,
        createdAt: null,
        history: [{ role: "user", text: "hi", createdAt: "2026-11-14T09:00:00.000Z" }],
        omittedMessageCount: 1,
      },
      now,
    );
    expect(events.map((e) => e.type)).toEqual([
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
    ]);
    const notice = events[0]?.payload as { message: string; ordinal: number };
    expect(notice.message).toContain("1 earlier message is not shown");
    expect(notice.ordinal).toBe(0);
  });
});
