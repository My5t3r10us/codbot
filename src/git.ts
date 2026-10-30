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

// ---------- vue Git : historique, worktrees, différences ----------

export type GraphCommit = { sha: string; parents: string[]; refs: string[]; subject: string; author: string; at: number };

/** Historique de la branche principale et des branches `cu/*` (plus quelques révisions en extra). */
export async function graphLog(repo: string, base: string, extra: string[] = [], max = 80): Promise<GraphCommit[]> {
  const log = (revs: string[]) => git(repo, "log", "--date-order", `-n${max}`, "--format=%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%at", ...revs, "--");
  // Sans remote (ou avant le premier fetch), origin/<base> n'existe pas : on s'en passe.
  const out = await log([`origin/${base}`, base, "--branches=cu/*", ...extra]).catch(() => log([base, "--branches=cu/*", ...extra]));
  if (!out) return [];
  return out.split(/\r?\n/).map((line) => {
    const [sha, parents, refs, subject, author, at] = line.split("\x1f");
    return {
      sha,
      parents: parents ? parents.split(" ") : [],
      refs: refs ? refs.split(", ").map((r) => r.replace(/^HEAD -> /, "")).filter((r) => r && r !== "HEAD") : [],
      subject,
      author,
      at: Number(at) * 1000,
    };
  });
}

export type Worktree = { path: string; head: string; branch: string | null };

export async function worktreeList(repo: string): Promise<Worktree[]> {
  const out = await git(repo, "worktree", "list", "--porcelain");
  const list: Worktree[] = [];
  let cur: Partial<Worktree> = {};
  for (const line of [...out.split(/\r?\n/), ""]) {
    if (!line) {
      if (cur.path) list.push({ path: cur.path, head: cur.head ?? "", branch: cur.branch ?? null });
      cur = {};
      continue;
    }
    if (line.startsWith("worktree ")) cur.path = line.slice(9);
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return list;
}

/** Commits d'avance et de retard d'un worktree par rapport à `origin/<base>`. */
export async function aheadBehind(path: string, base: string) {
  const out = await git(path, "rev-list", "--left-right", "--count", `origin/${base}...HEAD`).catch(() => "0\t0");
  const [behind, ahead] = out.split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

export async function changedFiles(path: string) {
  const out = await git(path, "status", "--porcelain");
  return out ? out.split(/\r?\n/).length : 0;
}

export type FileStat = { path: string; add: number; del: number; untracked?: boolean };

/** Fichiers modifiés depuis `base` (commits et modifications non commitées). */
export async function diffStat(path: string, base: string): Promise<FileStat[]> {
  const out = await git(path, "diff", "--numstat", base);
  const files: FileStat[] = out
    ? out.split(/\r?\n/).map((l) => {
        const [add, del, ...rest] = l.split("\t");
        return { path: rest.join("\t"), add: Number(add) || 0, del: Number(del) || 0 };
      })
    : [];
  const untracked = await git(path, "ls-files", "--others", "--exclude-standard");
  for (const f of untracked ? untracked.split(/\r?\n/) : []) files.push({ path: f, add: 0, del: 0, untracked: true });
  return files;
}

export async function diffFile(path: string, base: string, file: string) {
  return git(path, "diff", base, "--", file);
}

export async function fetchOrigin(repo: string) {
  await git(repo, "fetch", "origin", "--prune");
}
