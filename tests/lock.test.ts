import { describe, expect, it } from "vitest";
import { branchName, worktreePath } from "../src/git";
import { LOCK_PREFIX, lockOf, lockTag } from "../src/lock";

describe("verrou multi-PC", () => {
  it("dérive un tag stable du nom du PC", () => {
    expect(lockTag("L25-FNBW694")).toBe("codbot-l25-fnbw694");
    expect(lockTag("PC Bureau É")).toBe("codbot-pc-bureau");
    expect(lockTag("---")).toBe("codbot-pc");
    expect(LOCK_PREFIX).toBe("codbot-");
  });

  it("trouve le verrou quelle que soit la casse", () => {
    expect(lockOf({ tags: [{ name: "small" }, { name: "Codbot-L25" }] })).toBe("codbot-l25");
    expect(lockOf({ tags: [{ name: "small" }] })).toBeNull();
  });
});

describe("noms git", () => {
  it("nomme la branche cu/<id>-<titre> sans accents ni ponctuation", () => {
    expect(branchName("1amh1wae3hg", "Redesign de la page à faire !")).toBe("cu/1amh1wae3hg-redesign-de-la-page-a-faire");
    expect(branchName("x", "!!!")).toBe("cu/x");
    expect(branchName("x", "a".repeat(80))).toHaveLength("cu/x-".length + 40);
  });

  it("place le worktree à côté du repo", () => {
    expect(worktreePath("C:\\Code\\CBM\\site", "2cc2c998-8014")).toBe("C:\\Code\\CBM\\.codbot-worktrees\\site\\2cc2c998");
    expect(worktreePath("/home/u/repo/", "abcdef12-x")).toBe("/home/u/.codbot-worktrees/repo/abcdef12");
  });
});
