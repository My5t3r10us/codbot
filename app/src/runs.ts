// Moteur de runs (M1 : une tâche, stratégie direct-main) et synchronisation des statuts ClickUp.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { AgentSession } from "./agent";
import * as cu from "./clickup";
import * as db from "./db";
import type { Project, Run, RunState, StatusEvent } from "./db";
import * as git from "./git";

export const ACTIVE_STATES: RunState[] = ["preparing", "running", "waiting_permission", "waiting_reply", "pushing"];

/** Outils sans effet de bord, autorisés sans demander. */
const SAFE_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ToolSearch"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Une permission sans réponse au-delà de ce délai fait passer la tâche à « Bloqué ». */
const BLOCKED_AFTER_MS = 60_000;

export type Permission = { id: string; runId: string; tool: string; input: Record<string, unknown>; at: number };
export type Suggestion = { id: string; runId: string; taskId: string; taskName: string; status?: string; comment?: string };

const sessions = new Map<string, AgentSession>();
const nudged = new Set<string>();
export const permissions = new Map<string, Permission>();
export const suggestions = new Map<string, Suggestion>();

// ---------- abonnements de l'interface ----------

const listeners = new Set<() => void>();
export function onChange(fn: () => void) {
  listeners.add(fn);
}
function changed() {
  for (const fn of listeners) fn();
}

async function notify(title: string, body: string) {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (granted) sendNotification({ title, body });
}

async function log(runId: string, type: string, text: string) {
  await db.addRunEvent(runId, type, text);
  changed();
}

async function setState(runId: string, state: RunState, patch: Parameters<typeof db.updateRun>[1] = {}) {
  const ended = ["done", "failed", "stopped", "blocked"].includes(state) ? new Date().toISOString() : null;
  await db.updateRun(runId, { ...patch, state, ended_at: ended });
  await syncKeepAwake();
  changed();
}

/** L'anti-veille reste actif tant qu'un run travaille. */
async function syncKeepAwake() {
  const anyActive = [...sessions.values()].some((s) => s.running);
  await invoke("keep_awake", { on: anyActive }).catch(() => {});
}

// ---------- statuts ClickUp ----------

async function syncStatus(run: Run, event: StatusEvent, comment?: string) {
  const mode = await db.getSetting<"auto" | "manual">("status_mode", "auto");
  const status = (await db.getMappings(run.list_id))[event];
  if (!status && !comment) return;
  for (const [i, taskId] of run.task_ids.entries()) {
    const s: Suggestion = { id: crypto.randomUUID(), runId: run.id, taskId, taskName: run.task_names[i], status, comment };
    if (mode === "auto") await applySuggestion(s);
    else {
      suggestions.set(s.id, s);
      await log(run.id, "status", `suggestion : ${status ? `passer en « ${status} »` : "commentaire"} (mode manuel)`);
    }
  }
  changed();
}

async function applySuggestion(s: Suggestion) {
  try {
    if (s.status) {
      await cu.setTaskStatus(s.taskId, s.status);
      await log(s.runId, "status", `ClickUp : « ${s.taskName} » → ${s.status}`);
    }
    if (s.comment) {
      await cu.addComment(s.taskId, s.comment);
      await log(s.runId, "status", `ClickUp : commentaire ajouté sur « ${s.taskName} »`);
    }
  } catch (e) {
    await log(s.runId, "error", `ClickUp : ${(e as Error).message}`);
  }
}

export async function acceptSuggestion(id: string) {
  const s = suggestions.get(id);
  if (!s) return;
  suggestions.delete(id);
  changed();
  await applySuggestion(s);
}

export function dismissSuggestion(id: string) {
  suggestions.delete(id);
  changed();
}

// ---------- lancement ----------

function buildBrief(task: cu.CuTask, run: Run) {
  const lines = [
    `Tu travailles sur une tâche ClickUp, dans un worktree git dédié (HEAD détaché, basé sur origin/${run.base_branch}).`,
    "",
    `# ${task.name} [CU-${task.id}]`,
    `Lien : ${task.url}`,
    task.tags.length ? `Tags : ${task.tags.map((t) => t.name).join(", ")}` : "",
    "",
    "## Description",
    task.markdown_description?.trim() || task.text_content?.trim() || "(vide)",
  ];
  if (task.subtasks?.length) {
    lines.push("", "## Sous-tâches");
    for (const st of task.subtasks) lines.push(`- ${st.name} (CU-${st.id}, ${st.status.status})`);
  }
  for (const cl of task.checklists ?? []) {
    lines.push("", `## Checklist : ${cl.name}`);
    for (const it of cl.items) lines.push(`- [${it.resolved ? "x" : " "}] ${it.name}`);
  }
  lines.push(
    "",
    "## Consignes",
    `- Travaille uniquement dans ce dossier : ${run.worktree_path}`,
    `- Quand le travail est fini et vérifié, commite avec un message au format \`<type>: <résumé> [CU-${task.id}]\` (type : feat, fix, refactor, docs, test ou chore).`,
    "- Ne fais pas de push et ne change pas de branche : Codbot pousse lui-même après tes commits.",
    "- S'il te manque une information, pose ta question et arrête-toi sans commiter.",
    "- Termine par un court résumé de ce que tu as fait.",
  );
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

export async function launchRun(task: cu.CuTask, project: Project) {
  const busy = (await db.listRuns()).find((r) => r.repo_path === project.repo_path && ACTIVE_STATES.includes(r.state));
  if (busy) throw new Error(`Un run direct-main est déjà actif sur ce repo (${busy.task_names.join(", ")}).`);
  if (!(await git.hasRemote(project.repo_path))) throw new Error(`Le repo ${project.repo_path} n'a pas de remote « origin ».`);

  const run: Run = {
    id: crypto.randomUUID(),
    task_ids: [task.id],
    task_names: [task.name],
    list_id: project.list_id,
    repo_path: project.repo_path,
    worktree_path: null,
    base_branch: project.base_branch,
    git_strategy: "direct-main",
    session_id: null,
    state: "preparing",
    base_commit: null,
    pushed_commit: null,
    summary: null,
    error: null,
    created_at: new Date().toISOString(),
    ended_at: null,
  };
  await db.insertRun(run);
  changed();
  try {
    run.worktree_path = git.worktreePath(project.repo_path, run.id);
    run.base_commit = await git.createWorktree(project.repo_path, project.base_branch, run.worktree_path);
    await db.updateRun(run.id, { worktree_path: run.worktree_path, base_commit: run.base_commit });
    await log(run.id, "git", `worktree ${run.worktree_path} sur origin/${run.base_branch} (${run.base_commit.slice(0, 7)})`);
    const full = await cu.getTask(task.id);
    await startSession(run, buildBrief(full, run));
    await syncStatus(run, "started");
  } catch (e) {
    await fail(run.id, e);
  }
  return run.id;
}

async function startSession(run: Run, prompt: string, resume = false) {
  const model = (await db.getSetting<string>("model", "")).trim() || null;
  const session = new AgentSession(
    run.id,
    run.worktree_path!,
    {
      onSession: (id) => void db.updateRun(run.id, { session_id: id }),
      onLog: (type, text) => void log(run.id, type, text),
      onTurnEnd: (r) => void handleTurnEnd(run.id, r).catch((e) => fail(run.id, e)),
      onRateLimit: (text) => {
        void log(run.id, "rate_limit", text);
        void notify("Codbot : limite d'usage", text.slice(0, 120));
      },
      onExit: (code) => void onExit(run.id, code),
    },
    model,
  );
  sessions.set(run.id, session);
  await setState(run.id, "running");
  await session.start(prompt, resume ? run.session_id : null);
}

async function onExit(runId: string, code: number | null) {
  sessions.delete(runId);
  await syncKeepAwake();
  const run = await db.getRun(runId);
  if (run && ["running", "waiting_permission"].includes(run.state)) {
    await log(runId, "error", `le processus claude s'est arrêté (code ${code})`);
    await setState(runId, "stopped");
  }
}

// ---------- fin de tour : vérifier les commits puis pousser ----------

async function handleTurnEnd(runId: string, result: { isError: boolean; text: string }) {
  const run = await db.getRun(runId);
  if (!run?.worktree_path || !run.base_commit) return;
  await db.updateRun(runId, { summary: result.text });
  run.summary = result.text;

  if (result.isError) {
    await block(run, `L'agent a terminé en erreur : ${result.text.slice(0, 500)}`);
    return;
  }
  const commits = await git.commitsSince(run.worktree_path, run.base_commit);
  if (commits.length === 0) {
    await setState(runId, "waiting_reply");
    await log(runId, "info", "aucun commit : l'agent attend sans doute une réponse");
    await syncStatus(run, "blocked");
    await notify("Codbot : l'agent attend", run.task_names.join(", "));
    return;
  }
  if (await git.isDirty(run.worktree_path)) {
    if (!nudged.has(runId)) {
      nudged.add(runId);
      await sessions.get(runId)?.send("Il reste des modifications non commitées dans le worktree : commite-les ou annule-les, puis termine.");
      return;
    }
    await block(run, "Des modifications restent non commitées après relance.");
    return;
  }
  for (const id of run.task_ids) {
    if (!commits.some((c) => c.subject.includes(`CU-${id}`))) {
      await log(runId, "warn", `aucun commit ne porte l'ID CU-${id}`);
    }
  }
  await pushRun(run, commits);
}

async function pushRun(run: Run, commits: git.Commit[]) {
  await setState(run.id, "pushing");
  const project = await db.getProject(run.list_id);
  if (project?.verify_command) {
    await log(run.id, "git", `vérification : ${project.verify_command}`);
    const v = await git.runVerify(run.worktree_path!, project.verify_command);
    if (!v.ok) {
      await block(run, `La vérification a échoué :\n${v.output}`);
      return;
    }
  }
  try {
    const sha = await git.rebaseAndPush(run.worktree_path!, run.base_branch);
    await setState(run.id, "done", { pushed_commit: sha });
    await log(run.id, "git", `poussé sur ${run.base_branch} (${sha.slice(0, 7)})`);
    const web = await git.remoteWebUrl(run.repo_path);
    const comment = [
      `Codbot : poussé sur ${run.base_branch}.`,
      "",
      "Commits :",
      ...commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.subject}`),
      web ? `\n${web}/commit/${sha}` : "",
      "",
      "Résumé de l'agent :",
      (run.summary ?? "").slice(0, 1500),
    ].join("\n");
    await syncStatus(run, "done", comment);
    await finish(run);
    await notify("Codbot : tâche poussée", run.task_names.join(", "));
  } catch (e) {
    await block(run, (e as Error).message);
  }
}

async function block(run: Run, reason: string) {
  await setState(run.id, "blocked", { error: reason });
  await log(run.id, "error", reason);
  await syncStatus(run, "blocked", `Codbot : run bloqué.\n\n${reason.slice(0, 1500)}`);
  await notify("Codbot : run bloqué", run.task_names.join(", "));
}

async function fail(runId: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  await sessions.get(runId)?.stop();
  sessions.delete(runId);
  await setState(runId, "failed", { error: msg });
  await log(runId, "error", msg);
}

async function finish(run: Run) {
  await sessions.get(run.id)?.stop();
  sessions.delete(run.id);
  await git.removeWorktree(run.repo_path, run.worktree_path!);
  await syncKeepAwake();
}

// ---------- actions de l'utilisateur ----------

export async function sendMessage(runId: string, text: string) {
  const run = await db.getRun(runId);
  if (!run) return;
  const session = sessions.get(runId);
  if (session?.running) {
    await session.send(text);
    await setState(runId, "running");
    await syncStatus(run, "started");
  } else {
    await startSession(run, text, Boolean(run.session_id));
    await syncStatus(run, "started");
  }
}

export async function resumeRun(runId: string) {
  await sendMessage(runId, "Reprends là où tu t'étais arrêté, puis termine en suivant les consignes de départ.");
}

export async function stopRun(runId: string) {
  await sessions.get(runId)?.stop();
  sessions.delete(runId);
  await setState(runId, "stopped");
}

/** Revérifie les commits et retente la vérification et le push (après correction manuelle, par exemple). */
export async function retryPush(runId: string) {
  const run = await db.getRun(runId);
  if (!run?.worktree_path || !run.base_commit) return;
  const commits = await git.commitsSince(run.worktree_path, run.base_commit);
  if (!commits.length) throw new Error("Aucun commit à pousser.");
  await pushRun(run, commits);
}

export async function abandonRun(runId: string) {
  const run = await db.getRun(runId);
  if (!run) return;
  await sessions.get(runId)?.stop();
  sessions.delete(runId);
  if (run.worktree_path) await git.removeWorktree(run.repo_path, run.worktree_path);
  await setState(runId, "failed", { error: "Abandonné par l'utilisateur" });
}

export function isLive(runId: string) {
  return sessions.get(runId)?.running ?? false;
}

// ---------- permissions (hook PreToolUse) ----------

type HookEvent = { id: string; run_id: string; event: string; payload: Record<string, any>; blocking: boolean };

function isInside(path: unknown, dir: string | null) {
  if (typeof path !== "string" || !dir) return false;
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "");
  return norm(path).startsWith(norm(dir) + "\\");
}

async function onHook(h: HookEvent) {
  if (!h.blocking) {
    if (h.event === "Notification") await log(h.run_id, "info", String(h.payload.message ?? ""));
    return;
  }
  const run = await db.getRun(h.run_id);
  const tool = String(h.payload.tool_name ?? "");
  const input = (h.payload.tool_input ?? {}) as Record<string, unknown>;
  const autoAllow = SAFE_TOOLS.has(tool) || (EDIT_TOOLS.has(tool) && isInside(input.file_path ?? input.notebook_path, run?.worktree_path ?? null));
  if (!run || autoAllow) {
    await invoke("resolve_hook", { id: h.id, behavior: run ? "allow" : "deny", reason: run ? "Autorisé par Codbot" : "Run inconnu" });
    return;
  }
  const p: Permission = { id: h.id, runId: run.id, tool, input, at: Date.now() };
  permissions.set(p.id, p);
  await setState(run.id, "waiting_permission");
  await log(run.id, "permission", `demande : ${tool} ${JSON.stringify(input).slice(0, 200)}`);
  setTimeout(async () => {
    if (!permissions.has(p.id)) return;
    await syncStatus(run, "blocked");
    await notify("Codbot : permission en attente", `${tool} · ${run.task_names.join(", ")}`);
  }, BLOCKED_AFTER_MS);
}

export async function decide(permissionId: string, allow: boolean) {
  const p = permissions.get(permissionId);
  if (!p) return;
  permissions.delete(permissionId);
  const ok = await invoke<boolean>("resolve_hook", {
    id: p.id,
    behavior: allow ? "allow" : "deny",
    reason: allow ? "Autorisé depuis Codbot" : "Refusé depuis Codbot",
  });
  await log(p.runId, "permission", ok ? `${allow ? "autorisé" : "refusé"} : ${p.tool}` : "décision arrivée trop tard");
  const stillWaiting = [...permissions.values()].some((x) => x.runId === p.runId);
  if (!stillWaiting) {
    await setState(p.runId, "running");
    // La tâche n'est repassée « En cours » que si elle avait été marquée « Bloqué ».
    if (Date.now() - p.at >= BLOCKED_AFTER_MS) {
      const run = await db.getRun(p.runId);
      if (run) await syncStatus(run, "started");
    }
  }
}

// ---------- démarrage de l'app ----------

export async function init() {
  await listen<HookEvent>("hook", ({ payload }) => void onHook(payload));
  // Après un redémarrage, aucun processus claude ne survit : les runs actifs deviennent reprenables.
  for (const run of await db.listRuns()) {
    if (ACTIVE_STATES.includes(run.state)) {
      await db.updateRun(run.id, { state: "stopped" });
      await db.addRunEvent(run.id, "info", "Codbot a redémarré : run arrêté, reprise possible");
    }
  }
}
