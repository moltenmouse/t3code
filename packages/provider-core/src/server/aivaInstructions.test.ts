import { describe, expect, it } from "vite-plus/test";

import { aivaDisabledTools, aivaOrchestrationSections } from "./aivaInstructions.ts";
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
    expect(text).toContain("If you are a subagent or child, do the work yourself.");
    // Every kept line comes from upstream.
    const upstream = T3_CODE_ORCHESTRATION_SECTIONS.join("\n");
    for (const line of text.split("\n")) expect(upstream).toContain(line);
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
