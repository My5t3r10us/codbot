import { describe, expect, it } from "vitest";
import type { Run, RunEvent } from "../src/db";
import { activityText, basename, mmss, planProgress, toolText } from "../src/app/format";

const ev = (type: string, text: string): RunEvent => ({ id: 1, run_id: "r", type, text, at: "" });

describe("format", () => {
  it("mmss", () => {
    expect(mmss(65_000)).toBe("01:05");
    expect(mmss(3_725_000)).toBe("1:02:05");
  });

  it("basename (Windows et Unix)", () => {
    expect(basename("C:\\Code\\codbot\\src\\main.tsx")).toBe("main.tsx");
    expect(basename("/a/b/")).toBe("b");
  });

  it("toolText lit l'outil et sa cible", () => {
    expect(toolText('Edit {"file_path":"C:\\\\Code\\\\x\\\\app.ts","old_string":"a"}')).toEqual({ name: "Edit", target: "app.ts" });
    expect(toolText('Bash {"command":"npm test"}')).toEqual({ name: "Bash", target: "npm test" });
  });

  it("activityText : état d'attente, étape du plan, outil", () => {
    const run = { state: "running", error: null, pr_url: null } as Run;
    expect(activityText({ ...run, state: "waiting_permission" }, undefined)).toBe("Attend ton accord");
    expect(activityText(run, ev("todos", JSON.stringify([{ content: "Écrire", status: "in_progress", activeForm: "Écrit le test" }])))).toBe("Écrit le test");
    expect(activityText(run, ev("tool", 'Read {"file_path":"/x/y.ts"}'))).toBe("Read y.ts");
  });

  it("planProgress", () => {
    expect(planProgress(ev("todos", JSON.stringify([{ content: "a", status: "completed" }, { content: "b", status: "pending" }])))).toBe(0.5);
    expect(planProgress(undefined)).toBeNull();
  });
});
