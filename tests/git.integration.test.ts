// Séquences git réelles des stratégies direct-main et branche, sur des repos temporaires
// (un dépôt « origin » nu + un clone), avec le vrai binaire git.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as git from "../src/git";

const run = (args: string[]) =>
  new Promise<git.GitOutput>((resolve) =>
    execFile("git", args, (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr })),
  );

let root: string;
let repo: string;
const ident = ["-c", "user.name=test", "-c", "user.email=test@local"];

async function commitFile(dir: string, name: string, message: string) {
  writeFileSync(join(dir, name), `${name}\n`);
  await git.git(dir, "add", name);
  await git.git(dir, ...ident, "commit", "-m", message);
}

beforeAll(async () => {
  git.setGitExecutor(run);
  root = mkdtempSync(join(tmpdir(), "codbot-git-"));
  const origin = join(root, "origin.git");
  repo = join(root, "repo");
  await run(["init", "-q", "--bare", "-b", "main", origin]);
  await run(["clone", "-q", origin, repo]);
  await run(["-C", repo, "checkout", "-q", "-b", "main"]);
  await commitFile(repo, "README.md", "init");
  await git.git(repo, "push", "-q", "-u", "origin", "main");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("direct-main", () => {
  it("worktree détaché, commit, rebase et push sur main", async () => {
    expect(await git.hasRemote(repo)).toBe(true);
    const wt = git.worktreePath(repo, "aaaaaaaa-run");
    const base = await git.createWorktree(repo, "main", wt);
    await commitFile(wt, "a.txt", "feat: a [CU-1]");
    expect(await git.isDirty(wt)).toBe(false);
    const commits = await git.commitsSince(wt, base);
    expect(commits.map((c) => c.subject)).toEqual(["feat: a [CU-1]"]);

    // Pendant ce temps, quelqu'un pousse sur main : le rebase doit l'intégrer.
    await commitFile(repo, "other.txt", "chore: autre");
    await git.git(repo, "push", "-q", "origin", "main");

    const sha = await git.rebaseAndPush(wt, "main");
    expect(await git.isMergedInto(repo, sha, "main")).toBe(true);
    await git.removeWorktree(repo, wt);
    expect(await git.git(repo, "worktree", "list")).not.toContain("aaaaaaaa");
  });

  it("annule le rebase en cas de conflit et lève une GitError", async () => {
    const wt = git.worktreePath(repo, "bbbbbbbb-run");
    await git.createWorktree(repo, "main", wt);
    writeFileSync(join(wt, "README.md"), "version agent\n");
    await git.git(wt, ...ident, "commit", "-am", "feat: conflit [CU-2]");
    await git.git(repo, "pull", "-q", "origin", "main");
    writeFileSync(join(repo, "README.md"), "version humaine\n");
    await git.git(repo, ...ident, "commit", "-qam", "docs: humain");
    await git.git(repo, "push", "-q", "origin", "main");

    await expect(git.rebaseAndPush(wt, "main")).rejects.toThrow(/Conflit au rebase/);
    expect(await git.isDirty(wt)).toBe(false);
    await git.removeWorktree(repo, wt);
  });
});

describe("branche", () => {
  it("branche dédiée, push, puis détection du merge", async () => {
    const branch = git.branchName("cu1", "Changement titre");
    const wt = git.worktreePath(repo, "cccccccc-run");
    const base = await git.createBranchWorktree(repo, "main", branch, wt);
    await commitFile(wt, "b.txt", "feat: b [CU-cu1]");
    const sha = await git.pushBranch(wt, branch);
    expect((await git.commitsSince(wt, base)).length).toBe(1);
    expect(await git.isMergedInto(repo, sha, "main")).toBe(false);

    // Merge côté « GitHub » : ici, un merge --no-ff poussé sur main.
    await git.git(repo, "pull", "-q", "origin", "main");
    await git.git(repo, ...ident, "merge", "-q", "--no-ff", "-m", "Merge PR", `origin/${branch}`);
    await git.git(repo, "push", "-q", "origin", "main");
    expect(await git.isMergedInto(repo, sha, "main")).toBe(true);

    await git.removeWorktree(repo, wt);
    await git.deleteLocalBranch(repo, branch);
    expect(await git.git(repo, "branch", "--list", branch)).toBe("");
  });
});
