// Opérations git via le plugin shell. Toutes passent par `git -C <dossier>`.
import { Command } from "@tauri-apps/plugin-shell";

export class GitError extends Error {}
/** Le rebase sur la branche principale a échoué en conflit (il a été annulé). */
export class RebaseConflict extends GitError {}

export type GitOutput = { code: number | null; stdout: string; stderr: string };
type GitExecutor = (args: string[]) => Promise<GitOutput>;

let execute: GitExecutor = (args) => Command.create("git", args).execute();

/** Remplace l'exécution de git (tests d'intégration hors Tauri). */
export function setGitExecutor(fn: GitExecutor) {
  execute = fn;
}

export async function git(cwd: string, ...args: string[]) {
  const out = await execute(["-C", cwd, ...args]);
  if (out.code !== 0) throw new GitError(`git ${args.join(" ")} : ${(out.stderr || out.stdout).trim()}`);
  return out.stdout.trim();
}

export async function hasRemote(repo: string, name = "origin") {
  return (await git(repo, "remote")).split(/\r?\n/).includes(name);
}

export async function remoteWebUrl(repo: string) {
  try {
    const url = await git(repo, "remote", "get-url", "origin");
    const m = url.match(/github\.com[:/](.+?)(\.git)?$/);
    return m ? `https://github.com/${m[1]}` : null;
  } catch {
    return null;
  }
}

/** Dossier des worktrees : à côté du repo, pour ne jamais polluer son arbre de travail. */
export function worktreePath(repo: string, runId: string) {
  const norm = repo.replace(/[\\/]+$/, "");
  const sep = norm.includes("\\") ? "\\" : "/";
  const parent = norm.slice(0, norm.lastIndexOf(sep));
  const name = norm.slice(norm.lastIndexOf(sep) + 1);
  return [parent, ".codbot-worktrees", name, runId.slice(0, 8)].join(sep);
}

/** Worktree détaché, basé sur `origin/<base>` à jour. */
export async function createWorktree(repo: string, base: string, path: string) {
  await git(repo, "fetch", "origin", base);
  await git(repo, "worktree", "add", "--detach", path, `origin/${base}`);
  return git(path, "rev-parse", "HEAD");
}

/** Worktree sur une nouvelle branche `branch`, créée depuis `origin/<base>` à jour. */
export async function createBranchWorktree(repo: string, base: string, branch: string, path: string) {
  await git(repo, "fetch", "origin", base);
  await git(repo, "worktree", "add", "-b", branch, path, `origin/${base}`);
  return git(path, "rev-parse", "HEAD");
}

export async function removeWorktree(repo: string, path: string) {
  await git(repo, "worktree", "remove", "--force", path).catch(() => {});
  await git(repo, "worktree", "prune").catch(() => {});
}

export async function deleteLocalBranch(repo: string, branch: string) {
  await git(repo, "branch", "-D", branch).catch(() => {});
}

/** Nom de branche lisible : cu/<id>-<titre-en-slug>. */
export function branchName(taskId: string, title: string) {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return `cu/${taskId}${slug ? `-${slug}` : ""}`;
}

/** Crée une branche sur le commit courant du worktree et s'y place (HEAD détaché → branche). */
export async function branchHere(path: string, branch: string) {
  await git(path, "switch", "-c", branch);
}

export async function pushBranch(path: string, branch: string) {
  await git(path, "push", "-u", "origin", `HEAD:refs/heads/${branch}`);
  return git(path, "rev-parse", "HEAD");
}

/** Vrai si `sha` est contenu dans `origin/<base>` (merge classique ou fast-forward). */
export async function isMergedInto(repo: string, sha: string, base: string) {
  await git(repo, "fetch", "origin", base);
  try {
    await git(repo, "merge-base", "--is-ancestor", sha, `origin/${base}`);
    return true;
  } catch {
    return false;
  }
}

export type Commit = { sha: string; subject: string };

export async function commitsSince(path: string, baseCommit: string): Promise<Commit[]> {
  const out = await git(path, "log", "--reverse", "--format=%H%x09%s", `${baseCommit}..HEAD`);
  return out
    ? out.split(/\r?\n/).map((l) => {
        const [sha, ...rest] = l.split("\t");
        return { sha, subject: rest.join("\t") };
      })
    : [];
}

export async function isDirty(path: string) {
  return (await git(path, "status", "--porcelain")) !== "";
}

/** Rebase sur `origin/<base>` puis push `HEAD:<base>`. En cas de conflit, le rebase est annulé. */
export async function rebaseAndPush(path: string, base: string) {
  await git(path, "fetch", "origin", base);
  try {
    await git(path, "rebase", `origin/${base}`);
  } catch (e) {
    await git(path, "rebase", "--abort").catch(() => {});
    throw new RebaseConflict(`Conflit au rebase sur origin/${base} : ${(e as Error).message}`);
  }
  await git(path, "push", "origin", `HEAD:${base}`);
  return git(path, "rev-parse", "HEAD");
}

/** Commande de vérification du projet (tests, build), lancée dans le worktree. */
export async function runVerify(path: string, command: string) {
  const out = await Command.create("cmd", ["/d", "/s", "/c", command], { cwd: path }).execute();
  return { ok: out.code === 0, output: (out.stdout + out.stderr).trim().slice(-2000) };
}
