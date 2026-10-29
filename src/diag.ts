// Diagnostic au démarrage : CLI claude connecté, git et gh disponibles, jeton ClickUp valide.
import { Command } from "@tauri-apps/plugin-shell";
import * as cu from "./clickup";

export type Check = { name: string; ok: boolean; detail: string };

async function run(cmd: string, args: string[]) {
  try {
    const out = await Command.create(cmd, args).execute();
    return { code: out.code, text: (out.stdout || out.stderr).trim() };
  } catch (e) {
    return { code: -1, text: String(e) };
  }
}

export async function runChecks(): Promise<Check[]> {
  const [claude, git, gh, clickup] = await Promise.all([
    run("claude", ["auth", "status"]).then((r): Check => {
      try {
        const s = JSON.parse(r.text);
        return s.loggedIn
          ? { name: "Claude Code", ok: true, detail: `connecté (${s.authMethod}${s.subscriptionType ? `, ${s.subscriptionType}` : ""})` }
          : { name: "Claude Code", ok: false, detail: "CLI non connecté : lance `claude` puis `/login`" };
      } catch {
        return { name: "Claude Code", ok: false, detail: r.code === -1 ? "CLI `claude` introuvable" : r.text.slice(0, 200) };
      }
    }),
    run("git", ["--version"]).then((r): Check => ({ name: "git", ok: r.code === 0, detail: r.code === 0 ? r.text : "git introuvable" })),
    run("gh", ["auth", "status"]).then((r): Check => ({
      name: "GitHub CLI",
      ok: r.code === 0,
      detail: r.code === 0 ? "connecté" : r.code === -1 ? "`gh` introuvable (PR impossibles)" : "non connecté : `gh auth login`",
    })),
    cu.getUser()
      .then((u): Check => ({ name: "ClickUp", ok: true, detail: `connecté en tant que ${u.username}` }))
      .catch((e): Check => ({ name: "ClickUp", ok: false, detail: (e as Error).message })),
  ]);
  return [claude, git, gh, clickup];
}
