// Opérations git via le plugin shell. Toutes passent par `git -C <dossier>`.
import { Command } from "@tauri-apps/plugin-shell";

export class GitError extends Error {}

export async function git(cwd: string, ...args: string[]) {
  const out = await Command.create("git", ["-C", cwd, ...args]).execute();
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

export async function removeWorktree(repo: string, path: string) {
  await git(repo, "worktree", "remove", "--force", path).catch(() => {});
  await git(repo, "worktree", "prune").catch(() => {});
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
    throw new GitError(`Conflit au rebase sur origin/${base} : ${(e as Error).message}`);
  }
  await git(path, "push", "origin", `HEAD:${base}`);
  return git(path, "rev-parse", "HEAD");
}

/** Commande de vérification du projet (tests, build), lancée dans le worktree. */
export async function runVerify(path: string, command: string) {
  const out = await Command.create("cmd", ["/d", "/s", "/c", command], { cwd: path }).execute();
  return { ok: out.code === 0, output: (out.stdout + out.stderr).trim().slice(-2000) };
}
