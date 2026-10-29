import { describe, expect, it } from "vitest";
import type { CuTask } from "../src/clickup";
import { BRIEF_BRANCH, BRIEF_WORKTREE, buildBrief, coveredTasks, fillBrief, matchesDue, rateLimitFrom, repoAllows, strategyRule, usageFrom } from "../src/rules";

const task = (id: string, extra: Partial<CuTask> = {}): CuTask => ({
  id,
  custom_id: null,
  name: `Tâche ${id}`,
  status: { status: "à faire", color: "#999", type: "open" },
  assignees: [],
  tags: [],
  url: `https://app.clickup.com/t/${id}`,
  parent: null,
  list: { id: "L", name: "Liste" },
  space: { id: "S" },
  due_date: null,
  ...extra,
});

describe("strategyRule", () => {
  it("impose une branche en mode séparé à plusieurs tâches", () => {
    const r = strategyRule([task("a"), task("b")], "separe", null, "main");
    expect(r.forced).toBe("branche");
  });

  it("impose une branche si un run est déjà actif sur le repo", () => {
    const r = strategyRule([task("a")], "separe", { task_names: ["Autre"] }, "main");
    expect(r.forced).toBe("branche");
    expect(r.reason).toContain("Autre");
  });

  it("propose direct-main avec le tag small (insensible à la casse)", () => {
    const r = strategyRule([task("a", { tags: [{ name: "Small" }] })], "groupe", null, "master");
    expect(r).toMatchObject({ forced: null, suggested: "direct-main" });
    expect(r.reason).toContain("master");
  });

  it("propose une branche par défaut", () => {
    expect(strategyRule([task("a")], "separe", null, "main")).toMatchObject({ forced: null, suggested: "branche" });
  });
});

describe("repoAllows (file d'attente)", () => {
  const active = [{ repo_path: "R1", git_strategy: "branche" as const }];
  it("un direct-main attend que le repo soit libre", () => {
    expect(repoAllows("direct-main", "R1", active)).toBe(false);
    expect(repoAllows("direct-main", "R2", active)).toBe(true);
  });
  it("une branche passe à côté d'autres branches, pas d'un direct-main", () => {
    expect(repoAllows("branche", "R1", active)).toBe(true);
    expect(repoAllows("branche", "R1", [{ repo_path: "R1", git_strategy: "direct-main" }])).toBe(false);
  });
});

describe("buildBrief", () => {
  it("décrit une tâche seule avec sa consigne de commit", () => {
    const b = buildBrief([task("abc", { markdown_description: "Faire X" })], { worktree: "C:\\wt", base: "main", branch: null });
    expect(b).toContain("# Tâche abc [CU-abc]");
    expect(b).toContain("Faire X");
    expect(b).toContain("HEAD détaché, basé sur origin/main");
    expect(b).toContain("[CU-abc]`");
    expect(b).not.toMatch(/\n\n\n/);
  });

  it("numérote les tâches d'un lot et demande un commit par tâche", () => {
    const b = buildBrief([task("a"), task("b", { subtasks: [task("c")], checklists: [{ name: "QA", items: [{ name: "ok", resolved: true }] }] })],
      { worktree: "W", base: "main", branch: "cu/a-x" });
    expect(b).toContain("2 tâches ClickUp liées");
    expect(b).toContain("# Tâche 2 : Tâche b [CU-b]");
    expect(b).toContain("- Tâche c (CU-c, à faire)");
    expect(b).toContain("- [x] ok");
    expect(b).toContain("un commit par tâche");
    expect(b).toContain("sur la branche cu/a-x");
  });

  it("remplace les repères d'un brief modifié à la main", () => {
    const edited = `Dossier ${BRIEF_WORKTREE}, branche ${BRIEF_BRANCH}.`;
    expect(fillBrief(edited, "C:\\wt", "cu/1-x")).toBe("Dossier C:\\wt, branche cu/1-x.");
  });
});

describe("coveredTasks", () => {
  it("une tâche seule est couverte par n'importe quel commit", () => {
    expect(coveredTasks(["a"], [{ subject: "feat: x" }])).toEqual(["a"]);
    expect(coveredTasks(["a"], [])).toEqual([]);
  });
  it("en lot, seules les tâches citées sont couvertes", () => {
    expect(coveredTasks(["a", "b"], [{ subject: "feat: x [CU-b]" }])).toEqual(["b"]);
  });
});

describe("rateLimitFrom", () => {
  it("ignore l'événement émis à chaque requête quand tout va bien", () => {
    expect(rateLimitFrom({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1 } })).toBeNull();
  });
  it("donne l'heure de réinitialisation en ms", () => {
    const r = rateLimitFrom({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1793317800 } });
    expect(r?.resetsAt).toBe(1793317800000);
  });
  it("reconnaît un résultat en erreur de limite", () => {
    expect(rateLimitFrom({ type: "result", is_error: true, result: "Usage limit reached" })?.resetsAt).toBeNull();
    expect(rateLimitFrom({ type: "result", is_error: false, result: "limit" })).toBeNull();
  });
});

describe("usageFrom", () => {
  it("lit les fenêtres d'usage de l'abonnement", () => {
    const u = usageFrom({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          five_hour: { utilization: 0, resetsAt: 1793317800, status: "allowed" },
          seven_day: { utilization: 0.53, resetsAt: 1793422800, status: "allowed" },
        },
      },
    }, 42);
    expect(u).toEqual({
      at: 42,
      windows: [
        { name: "5 h", utilization: 0, resetsAt: 1793317800000, status: "allowed" },
        { name: "7 j", utilization: 0.53, resetsAt: 1793422800000, status: "allowed" },
      ],
    });
  });
  it("ignore les autres messages", () => {
    expect(usageFrom({ type: "result" })).toBeNull();
  });
});

describe("matchesDue", () => {
  const now = new Date(2026, 9, 29, 15, 0); // 29 octobre 2026, 15 h
  const at = (d: number, h = 12) => String(new Date(2026, 9, d, h).getTime());
  it("trie en retard, aujourd'hui, cette semaine, sans échéance", () => {
    expect(matchesDue(at(29, 10), "overdue", now)).toBe(true);
    expect(matchesDue(at(29, 18), "overdue", now)).toBe(false);
    expect(matchesDue(at(29, 18), "today", now)).toBe(true);
    expect(matchesDue(at(30), "today", now)).toBe(false);
    expect(matchesDue(at(30), "week", now)).toBe(true);
    expect(matchesDue(String(new Date(2026, 10, 6).getTime()), "week", now)).toBe(false);
    expect(matchesDue(null, "none", now)).toBe(true);
    expect(matchesDue(at(30), "none", now)).toBe(false);
    expect(matchesDue(null, "today", now)).toBe(false);
    expect(matchesDue(null, "all", now)).toBe(true);
  });
});
