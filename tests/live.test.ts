import { describe, expect, it } from "vitest";
import { allowPatternFor, planFromEvents, subagentsFromEvents, todosFromToolUse, type Todo } from "../src/live";

describe("todosFromToolUse", () => {
  it("TodoWrite remplace toute la liste", () => {
    const next = todosFromToolUse("TodoWrite", { todos: [{ content: "A", status: "completed" }, { content: "B", status: "in_progress", activeForm: "Fait B" }] }, [{ content: "X", status: "pending" }]);
    expect(next).toEqual([{ content: "A", status: "completed", activeForm: undefined }, { content: "B", status: "in_progress", activeForm: "Fait B" }]);
  });

  it("TaskCreate ajoute, TaskUpdate modifie par numéro (à partir de 1)", () => {
    let plan: Todo[] = [];
    plan = todosFromToolUse("TaskCreate", { subject: "Lire le code" }, plan)!;
    plan = todosFromToolUse("TaskCreate", { subject: "Écrire le test" }, plan)!;
    plan = todosFromToolUse("TaskUpdate", { taskId: "1", status: "completed" }, plan)!;
    expect(plan.map((t) => t.status)).toEqual(["completed", "pending"]);
  });

  it("ignore les autres outils", () => {
    expect(todosFromToolUse("Read", { file_path: "a.ts" }, [])).toBeNull();
  });
});

describe("planFromEvents", () => {
  it("garde le dernier plan avec l'heure de début et de fin des étapes", () => {
    const ev = (at: string, todos: Todo[]) => ({ type: "todos", text: JSON.stringify(todos), at });
    const plan = planFromEvents([
      ev("2026-10-30T10:00:00Z", [{ content: "A", status: "in_progress" }, { content: "B", status: "pending" }]),
      { type: "tool", text: "Read {}", at: "2026-10-30T10:00:30Z" },
      ev("2026-10-30T10:01:00Z", [{ content: "A", status: "completed" }, { content: "B", status: "in_progress" }]),
    ]);
    expect(plan[0]).toMatchObject({ content: "A", status: "completed", startedAt: Date.parse("2026-10-30T10:00:00Z"), endedAt: Date.parse("2026-10-30T10:01:00Z") });
    expect(plan[1]).toMatchObject({ content: "B", status: "in_progress", startedAt: Date.parse("2026-10-30T10:01:00Z"), endedAt: null });
  });
});

describe("subagentsFromEvents", () => {
  it("le dernier événement de chaque sous-agent l'emporte", () => {
    const subs = subagentsFromEvents([
      { type: "subagent", text: JSON.stringify({ id: "t1", type: "Explore", description: "Cherche", status: "running", startedAt: 1, endedAt: null }), at: "" },
      { type: "subagent", text: JSON.stringify({ id: "t1", status: "done", endedAt: 5 }), at: "" },
    ]);
    expect(subs).toEqual([{ id: "t1", type: "Explore", description: "Cherche", status: "done", startedAt: 1, endedAt: 5 }]);
  });
});

describe("allowPatternFor", () => {
  it("Bash : les trois premiers mots de la commande", () => {
    expect(allowPatternFor("Bash", { command: "npm run test -- --watch=false" })).toBe("Bash(npm run test*)");
  });
  it("autre outil : son nom", () => {
    expect(allowPatternFor("WebFetch", { url: "https://x" })).toBe("WebFetch");
  });
});
