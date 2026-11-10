import { describe, expect, it } from "vite-plus/test";

import {
  AIVA_SENTENCE_REWRITES,
  AIVA_SENTENCES_KEPT,
  aivaDisabledTools,
  aivaOrchestrationSections,
} from "./aivaInstructions.ts";
import { T3_CODE_ORCHESTRATION_SECTIONS } from "./orchestrationInstructions.ts";

const HIDDEN = [
  "t3_thread_send",
  "t3_thread_send_attachments",
  "delegate_task",
  "task_status",
  "task_cancel",
  "create_threads",
  "t3_thread_wait",
  "t3_environment_link",
];

describe("aivaOrchestrationSections", () => {
  it("returns the sections unchanged with nothing hidden", () => {
    expect(aivaOrchestrationSections(T3_CODE_ORCHESTRATION_SECTIONS, [])).toBe(
      T3_CODE_ORCHESTRATION_SECTIONS,
    );
  });

  it("drops every bullet naming a hidden tool from t3's real sections, and nothing else", () => {
    const filtered = aivaOrchestrationSections(T3_CODE_ORCHESTRATION_SECTIONS, HIDDEN);
    const text = filtered.join("\n\n");
    for (const tool of HIDDEN) expect(text).not.toMatch(new RegExp(`\\b${tool}\\b`));
    // Unrelated guidance stays word for word.
    expect(text).toContain("Ordinary coding tasks need no T3 tools.");
    expect(text).toContain("call `request_secret`");
    expect(text).toContain("### Visuals and preview");
    expect(text).toContain("`html_preview`");
    expect(text).toContain("As a subagent or child, do the work yourself.");
    // Every kept sentence comes from upstream, word for word.
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const upstream = flat(T3_CODE_ORCHESTRATION_SECTIONS.join("\n"));
    const rewritten = new Set(Object.values(AIVA_SENTENCE_REWRITES));
    for (const line of text.split("\n")) {
      for (const sentence of flat(line.replace(/^- /, "")).split(/(?<=[.!?])\s+(?=[A-Z`"(])/)) {
        if (!rewritten.has(sentence)) expect(upstream).toContain(sentence);
      }
    }
  });

  it("drops only the sentences about a hidden tool, keeping the rest of the bullet", () => {
    const text = aivaOrchestrationSections(T3_CODE_ORCHESTRATION_SECTIONS, [
      ...HIDDEN,
      "request_secret",
    ]).join("\n\n");
    expect(text).not.toContain("request_secret");
    // What followed it about the secret goes too (its sudo recipe needs the secret file)…
    expect(text).not.toContain("Not for access you have.");
    expect(text).not.toContain("sudo -S");
    // …but the bullet's advice about another tool stays.
    expect(text).toContain("- Asked only to schedule: `schedule_task` without running its prompt.");
  });

  it("keeps the guidance that still applies around hidden tools", () => {
    const text = aivaOrchestrationSections(T3_CODE_ORCHESTRATION_SECTIONS, [
      ...HIDDEN,
      "create_threads",
    ]).join("\n\n");
    expect(text).toContain("Workflow only when asked.");
    expect(text).toContain(
      "`t3_thread_launch` makes new top-level threads, only when the user asks for a new thread.",
    );
    expect(text).toContain("Worktree thread: set `workspaceStrategy`");
    expect(text).not.toContain("create_threads");
  });

  it("still finds every sentence it rewrites or keeps in t3's text", () => {
    const upstream = T3_CODE_ORCHESTRATION_SECTIONS.join("\n").replace(/\s+/g, " ");
    for (const sentence of [...Object.keys(AIVA_SENTENCE_REWRITES), ...AIVA_SENTENCES_KEPT])
      expect(upstream).toContain(sentence);
  });

  it("keeps a bullet's sentences after the hidden part once another tool comes up", () => {
    const sections = [
      "- First use `delegate_task`. It reports back. Then `html_preview` the result. Done.",
    ];
    expect(aivaOrchestrationSections(sections, HIDDEN)).toEqual([
      "- Then `html_preview` the result. Done.",
    ]);
  });

  it("drops a section whose bullets were all about hidden tools", () => {
    const sections = [
      "## Only hidden\n\n- use `delegate_task`\n- or `task_status`",
      "## Kept\n\n- `html_preview`",
    ];
    expect(aivaOrchestrationSections(sections, HIDDEN)).toEqual(["## Kept\n\n- `html_preview`"]);
  });

  it("matches whole tool names only", () => {
    const sections = ["- `t3_thread_send_attachments` here", "- `t3_thread_sender` here"];
    expect(aivaOrchestrationSections(sections, ["t3_thread_send"])).toEqual([
      "- `t3_thread_send_attachments` here",
      "- `t3_thread_sender` here",
    ]);
  });
});

describe("aivaDisabledTools", () => {
  it("is empty without a settings file", () => {
    expect(aivaDisabledTools({ T3CODE_AIVA_SETTINGS: "/nonexistent/aiva.json" })).toEqual([]);
  });
});
