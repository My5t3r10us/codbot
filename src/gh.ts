// Pull requests GitHub via le CLI `gh` (connecté au compte de l'utilisateur).
import { Command } from "@tauri-apps/plugin-shell";

async function gh(cwd: string, ...args: string[]) {
  const out = await Command.create("gh", args, { cwd }).execute();
  if (out.code !== 0) throw new Error(`gh ${args[0]} ${args[1] ?? ""} : ${(out.stderr || out.stdout).trim()}`);
  return out.stdout.trim();
}

/** Ouvre une PR et renvoie son URL. Si une PR existe déjà pour la branche, renvoie la sienne. */
export async function createPr(cwd: string, opts: { base: string; head: string; title: string; body: string }) {
  const existing = await prState(cwd, opts.head).catch(() => null);
  if (existing && existing.state === "OPEN") return existing.url;
  const out = await gh(cwd, "pr", "create", "--base", opts.base, "--head", opts.head, "--title", opts.title, "--body", opts.body);
  return out.split(/\r?\n/).find((l) => l.startsWith("https://")) ?? out;
}

export type PrState = { url: string; state: "OPEN" | "CLOSED" | "MERGED"; mergedAt: string | null };

/** État d'une PR, désignée par son URL, son numéro ou sa branche. */
export async function prState(cwd: string, pr: string): Promise<PrState> {
  return JSON.parse(await gh(cwd, "pr", "view", pr, "--json", "url,state,mergedAt"));
}
