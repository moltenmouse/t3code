/**
 * P20: beside P7's import, a moved session's real start, its moved parent and its recent messages,
 * taken by thread creation in one transaction. The history is for people: the agent resumes the
 * native conversation, so `historyOrigin` stays unset and no handoff sends it again. AIVA_PATCHES.md.
 */
import {
  EventId,
  MessageId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface AivaImportedMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface AivaImportExtras {
  /** ISO time the session really started. */
  readonly createdAt: string | null;
  /** The moved parent's thread here. */
  readonly parentThreadId: string | null;
  /** The most recent messages, oldest first. */
  readonly history: ReadonlyArray<AivaImportedMessage>;
  /** Earlier messages left out of `history`. */
  readonly omittedMessageCount: number;
}

export const MAX_HISTORY_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 64 * 1024;
const MAX_HISTORY_CHARS = 2 * 1024 * 1024;
const THREAD_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const EVENT_PREFIX = "aiva-move";

function isoTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = DateTime.make(value);
  // A time after the thread's creation is clamped there (aivaCreatedAt).
  return Option.isNone(parsed) ? null : DateTime.formatIso(parsed.value);
}

/** The P20 fields of an import file, checked; null when it names none of them. */
export function parseAivaImportExtras(input: Record<string, unknown>): AivaImportExtras | null {
  const createdAt = isoTime(input.createdAt);
  const parentThreadId =
    typeof input.parentThreadId === "string" && THREAD_ID.test(input.parentThreadId)
      ? input.parentThreadId
      : null;
  const history: Array<AivaImportedMessage> = [];
  let total = 0;
  for (const raw of Array.isArray(input.history)
    ? input.history.slice(-MAX_HISTORY_MESSAGES)
    : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const at = isoTime(entry.createdAt);
    if ((entry.role !== "user" && entry.role !== "assistant") || typeof entry.text !== "string")
      continue;
    const text = entry.text.slice(0, MAX_MESSAGE_CHARS);
    if (text.trim() === "" || at === null) continue;
    if (total + text.length > MAX_HISTORY_CHARS) break;
    total += text.length;
    history.push({ role: entry.role, text, createdAt: at });
  }
  const omitted =
    typeof input.omittedMessageCount === "number" && Number.isSafeInteger(input.omittedMessageCount)
      ? Math.max(0, input.omittedMessageCount)
      : 0;
  if (createdAt === null && parentThreadId === null && history.length === 0) return null;
  return { createdAt, parentThreadId, history, omittedMessageCount: omitted };
}

// Staged by the launch handler for the thread it is about to create, taken by its creation.
const staged = new Map<string, AivaImportExtras>();

export function stageAivaImportExtras(threadId: string, extras: AivaImportExtras): void {
  staged.set(threadId, extras);
}

/** Takes what was staged for a thread (once); also how a failed launch drops it. */
export function takeAivaImportExtras(threadId: string): AivaImportExtras | null {
  const extras = staged.get(threadId) ?? null;
  staged.delete(threadId);
  return extras;
}

/** The thread's creation time: the session's own, when one was given and is earlier. */
export function aivaCreatedAt(extras: AivaImportExtras | null, now: DateTime.Utc): DateTime.Utc {
  if (extras?.createdAt == null) return now;
  const at = DateTime.makeUnsafe(extras.createdAt);
  return DateTime.toEpochMillis(at) < DateTime.toEpochMillis(now) ? at : now;
}

/** The history's events: a notice of what is left out, then each message and its item. */
export function aivaHistoryEvents(
  threadId: ThreadId,
  extras: AivaImportExtras,
  createdAt: DateTime.Utc,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const events: Array<OrchestrationV2DomainEvent> = [];
  const base = (ordinal: number, suffix: string, at: DateTime.Utc) => ({
    id: TurnItemId.make(`${EVENT_PREFIX}:turn-item:${threadId}:${suffix}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  });
  if (extras.history.length > 0 && extras.omittedMessageCount > 0) {
    const n = extras.omittedMessageCount;
    const notice: OrchestrationV2TurnItem = {
      ...base(0, "omitted", createdAt),
      type: "system_notice",
      message: `Moved from old Aiva. ${n} earlier ${n === 1 ? "message is" : "messages are"} not shown here; the agent still has the whole conversation.`,
    };
    events.push({
      id: EventId.make(`${EVENT_PREFIX}:omitted:${threadId}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: createdAt,
      payload: notice,
    });
  }
  extras.history.forEach((entry, index) => {
    const suffix = String(index).padStart(6, "0");
    const at = DateTime.makeUnsafe(entry.createdAt);
    const messageId = MessageId.make(`${EVENT_PREFIX}:${threadId}:${suffix}`);
    const message: OrchestrationV2ConversationMessage = {
      createdBy: entry.role === "user" ? "user" : "agent",
      creationSource: "server",
      id: messageId,
      threadId,
      runId: null,
      nodeId: null,
      role: entry.role,
      text: entry.text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    };
    const common = base(index + 1, suffix, at);
    const item: OrchestrationV2TurnItem =
      entry.role === "user"
        ? {
            ...common,
            createdBy: "user",
            creationSource: "server",
            type: "user_message",
            messageId,
            inputIntent: "turn_start",
            text: entry.text,
            attachments: [],
          }
        : { ...common, type: "assistant_message", messageId, text: entry.text, streaming: false };
    events.push(
      {
        id: EventId.make(`${EVENT_PREFIX}:message:${threadId}:${suffix}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: message,
      },
      {
        id: EventId.make(`${EVENT_PREFIX}:item:${threadId}:${suffix}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: item,
      },
    );
  });
  return events;
}
