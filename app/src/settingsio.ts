// Export / import des réglages communs entre PC. Jamais de secret (jeton ClickUp)
// ni de chemin local : chaque PC garde ses propres chemins de repos.
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as db from "./db";

const COMMON_SETTINGS = ["team_id", "status_mode", "model", "concurrency", "question_timeout_min", "unattended"] as const;

type ExportFile = {
  app: "codbot";
  version: 1;
  exported_at: string;
  settings: Record<string, unknown>;
  projects: Omit<db.Project, "repo_path">[];
  status_mappings: { list_id: string; event: db.StatusEvent; status: string }[];
};

export async function buildExport(): Promise<ExportFile> {
  const settings: Record<string, unknown> = {};
  for (const key of COMMON_SETTINGS) {
    const v = await db.getSetting<unknown>(key, undefined);
    if (v !== undefined) settings[key] = v;
  }
  return {
    app: "codbot",
    version: 1,
    exported_at: new Date().toISOString(),
    settings,
    projects: (await db.listProjects()).map(({ repo_path: _local, ...common }) => common),
    status_mappings: await db.listAllMappings(),
  };
}

/** Ouvre la boîte « Enregistrer sous » et écrit le fichier. Renvoie le chemin, ou null si annulé. */
export async function exportToFile() {
  const path = await save({ defaultPath: "codbot-reglages.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return null;
  await invoke("write_text_file", { path, content: JSON.stringify(await buildExport(), null, 2) });
  return path;
}

/** Applique un export : réglages, projets (en gardant les chemins locaux) et correspondances. */
export async function applyImport(data: unknown) {
  const file = data as Partial<ExportFile>;
  if (file?.app !== "codbot" || file.version !== 1) throw new Error("Ce fichier n'est pas un export de réglages Codbot.");
  for (const key of COMMON_SETTINGS) {
    if (key in (file.settings ?? {})) await db.setSetting(key, file.settings![key]);
  }
  const local = new Map((await db.listProjects()).map((p) => [p.list_id, p]));
  let toConfigure = 0;
  for (const p of file.projects ?? []) {
    const repo = local.get(p.list_id)?.repo_path ?? "";
    if (!repo) toConfigure++;
    await db.saveProject({ ...p, allowlist: p.allowlist ?? [], repo_path: repo });
  }
  for (const m of file.status_mappings ?? []) await db.setMapping(m.list_id, m.event, m.status);
  return { projects: file.projects?.length ?? 0, toConfigure };
}

export async function importFromFile() {
  const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return null;
  return applyImport(JSON.parse(await invoke<string>("read_text_file", { path })));
}
