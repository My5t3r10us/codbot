import { describe, expect, it } from "vitest";
import type { CuTask } from "../src/clickup";
import { dueInfo, initials, priorityLevel, withChildren } from "../src/taskview";

const now = new Date(2026, 9, 30, 12, 0);
const at = (d: number, h = 12) => String(new Date(2026, 9, 30 + d, h).getTime());

describe("dueInfo", () => {
  it("en retard, aujourd'hui, demain, plus tard", () => {
    expect(dueInfo(at(-2), now)).toMatchObject({ label: "En retard · 2 j", tone: "err" });
    expect(dueInfo(at(0, 18), now)).toMatchObject({ label: "Aujourd'hui", tone: "warn" });
    expect(dueInfo(at(1), now)).toMatchObject({ label: "Demain", soon: true });
    expect(dueInfo(at(20), now).soon).toBe(false);
    expect(dueInfo(null, now).label).toBe("");
  });
});

describe("priorityLevel", () => {
  it("urgent 4 … basse 1, aucune 0", () => {
    expect(priorityLevel({ priority: { priority: "urgent", color: "" } })).toBe(4);
    expect(priorityLevel({ priority: { priority: "low", color: "" } })).toBe(1);
    expect(priorityLevel({ priority: null })).toBe(0);
  });
});

describe("initials", () => {
  it("prend les initiales ClickUp ou les deux premiers mots", () => {
    expect(initials({ username: "x", initials: "bm" })).toBe("BM");
    expect(initials({ username: "Baptiste Moine" })).toBe("BM");
  });
});

describe("withChildren", () => {
  it("place chaque sous-tâche sous sa parente visible", () => {
    const t = (id: string, parent: string | null = null) => ({ id, parent }) as CuTask;
    const out = withChildren([t("c1", "p"), t("p"), t("x"), t("orphan", "absent")]);
    expect(out.map((r) => `${r.task.id}${r.sub ? "↳" : ""}`)).toEqual(["p", "c1↳", "x", "orphan"]);
  });
});
