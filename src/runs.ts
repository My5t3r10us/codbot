// Moteur de runs : modes séparé / groupé, stratégies direct-main / branche (PR),
// et synchronisation des statuts ClickUp tâche par tâche.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { AgentSession } from "./agent";
import { DEFAULT_ALLOWLIST, decideUnattended } from "./allowlist";
import * as cu from "./clickup";
import * as db from "./db";
import type { GitStrategy, Project, Run, RunMode, RunState, StatusEvent } from "./db";
import * as gh from "./gh";
import * as git from "./git";
import * as lock from "./lock";

/** États où un agent travaille (ou va travailler) dans le worktree. */
export const ACTIVE_STATES: RunState[] = ["preparing", "running", "waiting_permission", "waiting_reply", "pushing"];

/** Outils sans effet de bord, autorisés sans demander. */
const SAFE_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ToolSearch"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Une permission sans réponse au-delà de ce délai fait passer la tâche à « Bloqué ». */
const BLOCKED_AFTER_MS = 60_000;
/** Intervalle de vérification des PR en revue. */
const REVIEW_POLL_MS = 60_000;
/** Tag ClickUp qui propose direct-main par défaut. */
const SMALL_TAG = "small";

export type Permission = { id: string; runId: string; tool: string; input: Record<string, unknown>; at: number };
export type Suggestion = {
  id: string;
  runId: string;
  taskId: string;
  taskName: string;
  event: StatusEvent;
  status?: string;
  comment?: string;
};

const sessions = new Map<string, AgentSession>();
const nudged = new Set<string>();
/** Runs qui ont atteint la limite d'usage pendant le tour en cours → heure de réinitialisation (ms). */
const rateLimited = new Map<string, number | null>();
const timeouts = new Map<string, number>();
let queueActive = false;
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

const limitListeners = new Set<(resetsAt: number | null) => void>();
/** Prévient la file quand un agent atteint la limite d'usage de l'abonnement. */
export function onRateLimitHit(fn: (resetsAt: number | null) => void) {
  limitListeners.add(fn);
}

export async function setQueueActive(active: boolean) {
  queueActive = active;
  await syncKeepAwake();
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

/** L'anti-veille reste actif tant qu'un run travaille ou que la file tourne. */
async function syncKeepAwake() {
  const anyActive = queueActive || [...sessions.values()].some((s) => s.running);
  await invoke("keep_awake", { on: anyActive }).catch(() => {});
}

// ---------- statuts ClickUp ----------

/** Applique (ou propose, en mode manuel) un événement de statut aux tâches indiquées du run. */
async function syncStatus(run: Run, event: StatusEvent, comment?: string, taskIds: string[] = run.task_ids) {
  const mode = await db.getSetting<"auto" | "manual">("status_mode", "auto");
  const status = (await db.getMappings(run.list_id))[event];
  for (const taskId of taskIds) {
    const taskName = run.task_names[run.task_ids.indexOf(taskId)] ?? taskId;
    const s: Suggestion = { id: crypto.randomUUID(), runId: run.id, taskId, taskName, event, status, comment };
    if (event !== "blocked") run.task_progress[taskId] = event;
    if (!status && !comment) continue;
    if (mode === "auto") await applySuggestion(s);
    else {
      suggestions.set(s.id, s);
      await log(run.id, "status", `suggestion pour « ${taskName} » : ${status ? `passer en « ${status} »` : "commentaire"}`);
    }
  }
  await db.updateRun(run.id, { task_progress: run.task_progress });
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

// ---------- règle de stratégie git (§5.5 de la spec) ----------

export type StrategyChoice = { forced: GitStrategy | null; suggested: GitStrategy; reason: string };

export async function strategyFor(tasks: cu.CuTask[], project: Project, mode: RunMode): Promise<StrategyChoice> {
  const busy = (await db.listRuns()).filter((r) => r.repo_path === project.repo_path && ACTIVE_STATES.includes(r.state));
  if (mode === "separe" && tasks.length > 1) {
    return { forced: "branche", suggested: "branche", reason: "Plusieurs agents en parallèle : une branche par tâche." };
  }
  if (busy.length) {
    return { forced: "branche", suggested: "branche", reason: `Un run est déjà actif sur ce repo (${busy[0].task_names.join(", ")}).` };
  }
  const small = tasks.some((t) => t.tags.some((tag) => tag.name.toLowerCase() === SMALL_TAG));
  return small
    ? { forced: null, suggested: "direct-main", reason: `Tag « ${SMALL_TAG} » : commit direct sur ${project.base_branch} proposé.` }
    : { forced: null, suggested: "branche", reason: "Par défaut : branche et PR (tag « small » pour un commit direct)." };
}

// ---------- brief ----------

function taskSection(task: cu.CuTask, heading: string) {
  const lines = [
    `${heading} ${task.name} [CU-${task.id}]`,
    `Lien : ${task.url}`,
    task.tags.length ? `Tags : ${task.tags.map((t) => t.name).join(", ")}` : "",
    "",
    "Description :",
    task.markdown_description?.trim() || task.text_content?.trim() || "(vide)",
  ];
  if (task.subtasks?.length) {
    lines.push("", "Sous-tâches :");
    for (const st of task.subtasks) lines.push(`- ${st.name} (CU-${st.id}, ${st.status.status})`);
  }
  for (const cl of task.checklists ?? []) {
    lines.push("", `Checklist « ${cl.name} » :`);
    for (const it of cl.items) lines.push(`- [${it.resolved ? "x" : " "}] ${it.name}`);
  }
  return lines;
}

export function buildBrief(tasks: cu.CuTask[], ctx: { worktree: string; base: string; branch: string | null }) {
  const where = ctx.branch
    ? `sur la branche ${ctx.branch}, créée depuis origin/${ctx.base}`
    : `HEAD détaché, basé sur origin/${ctx.base}`;
  const lines = [
    tasks.length > 1
      ? `Tu travailles sur ${tasks.length} tâches ClickUp liées, dans un worktree git dédié (${where}).`
      : `Tu travailles sur une tâche ClickUp, dans un worktree git dédié (${where}).`,
    "",
  ];
  tasks.forEach((t, i) => lines.push(...taskSection(t, tasks.length > 1 ? `# Tâche ${i + 1} :` : "#"), ""));
  lines.push(
    "## Consignes",
    `- Travaille uniquement dans ce dossier : ${ctx.worktree}`,
    tasks.length > 1
      ? "- Fais au moins un commit par tâche. Chaque message porte l'ID de la tâche qu'il traite : `<type>: <résumé> [CU-<id>]` (type : feat, fix, refactor, docs, test ou chore)."
      : `- Quand le travail est fini et vérifié, commite avec un message au format \`<type>: <résumé> [CU-${tasks[0].id}]\` (type : feat, fix, refactor, docs, test ou chore).`,
    "- Ne fais pas de push et ne change pas de branche : Codbot pousse lui-même après tes commits.",
    "- S'il te manque une information, pose ta question et arrête-toi sans commiter.",
    "- Termine par un court résumé de ce que tu as fait.",
  );
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

// ---------- lancement ----------

/** Repères du brief prévisualisé avant le lancement, remplacés par les vraies valeurs. */
export const BRIEF_WORKTREE = "(dossier du worktree, créé au lancement)";
export const BRIEF_BRANCH = "(cu/<id>-<titre>)";

export type LaunchOptions = { mode: RunMode; strategy: GitStrategy; brief?: string };

/** Lance un ou plusieurs runs selon le mode. Renvoie les identifiants créés. */
export async function launch(tasks: cu.CuTask[], project: Project, opts: LaunchOptions) {
  if (!project.repo_path) throw new Error(`Renseigne le repo local de « ${project.list_name} » dans les Réglages de ce PC.`);
  const rule = await strategyFor(tasks, project, opts.mode);
  const strategy = rule.forced ?? opts.strategy;
  if (!(await git.hasRemote(project.repo_path))) throw new Error(`Le repo ${project.repo_path} n'a pas de remote « origin ».`);
  const groups = opts.mode === "groupe" ? [tasks] : tasks.map((t) => [t]);
  const ids: string[] = [];
  for (const group of groups) ids.push(await launchOne(group, project, opts.mode, strategy, groups.length === 1 ? opts.brief : undefined));
  return ids;
}

/** Lance un élément de la file (la règle de stratégie a été vérifiée par la file). */
export async function launchQueued(item: db.QueueItem, project: Project, queueSession: string) {
  const tasks = await Promise.all(item.task_ids.map((id) => cu.getTask(id)));
  return launchOne(tasks, project, item.mode, item.strategy, item.brief ?? undefined, queueSession);
}

async function launchOne(
  tasks: cu.CuTask[],
  project: Project,
  mode: RunMode,
  strategy: GitStrategy,
  briefOverride?: string,
  queueSession: string | null = null,
) {
  // Tâches relues à jour : verrou d'un autre PC, statut d'origine et brief.
  const fresh = await Promise.all(tasks.map((t) => cu.getTask(t.id)));
  for (const t of fresh) {
    const other = await lock.lockedByOther(t);
    if (other) throw new Error(`« ${t.name} » est déjà prise par un autre PC (tag ${other}).`);
  }
  tasks = fresh;
  // En mode groupé, la branche porte le nom de la tâche parente si elle fait partie du lot.
  const ids = new Set(tasks.map((t) => t.id));
  const lead = tasks.find((t) => tasks.some((o) => o.parent === t.id)) ?? tasks.find((t) => !t.parent || !ids.has(t.parent)) ?? tasks[0];
  const run: Run = {
    id: crypto.randomUUID(),
    task_ids: tasks.map((t) => t.id),
    task_names: tasks.map((t) => t.name),
    list_id: project.list_id,
    repo_path: project.repo_path,
    worktree_path: null,
    base_branch: project.base_branch,
    git_strategy: strategy,
    mode,
    branch: strategy === "branche" ? git.branchName(lead.id, lead.name) : null,
    pr_url: null,
    task_progress: {},
    task_initial_status: Object.fromEntries(tasks.map((t) => [t.id, t.status.status])),
    session_id: null,
    state: "preparing",
    base_commit: null,
    pushed_commit: null,
    summary: null,
    error: null,
    created_at: new Date().toISOString(),
    ended_at: null,
    queue_session: queueSession,
  };
  await db.insertRun(run);
  changed();
  for (const t of fresh) {
    await lock.acquire(t).catch((e) => log(run.id, "warn", `verrou ClickUp non posé sur « ${t.name} » : ${(e as Error).message}`));
  }
  try {
    run.worktree_path = git.worktreePath(project.repo_path, run.id);
    run.base_commit = run.branch
      ? await git.createBranchWorktree(project.repo_path, project.base_branch, run.branch, run.worktree_path)
      : await git.createWorktree(project.repo_path, project.base_branch, run.worktree_path);
    await db.updateRun(run.id, { worktree_path: run.worktree_path, base_commit: run.base_commit });
    await log(run.id, "git", `worktree ${run.worktree_path} ${run.branch ? `sur la branche ${run.branch}` : "détaché"} depuis origin/${run.base_branch} (${run.base_commit.slice(0, 7)})`);
    const full = fresh;
    const brief = briefOverride
      ? briefOverride.split(BRIEF_WORKTREE).join(run.worktree_path).split(BRIEF_BRANCH).join(run.branch ?? "")
      : buildBrief(full, { worktree: run.worktree_path, base: run.base_branch, branch: run.branch });
    await startSession(run, brief);
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
      onRateLimit: ({ text, resetsAt }) => {
        rateLimited.set(run.id, resetsAt);
        void log(run.id, "rate_limit", text);
        const when = resetsAt ? `Reprise vers ${new Date(resetsAt).toLocaleTimeString("fr-FR")}` : text.slice(0, 120);
        void notify("Codbot : limite d'usage atteinte", when);
        for (const fn of limitListeners) fn(resetsAt);
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

  if (rateLimited.has(runId)) {
    // Limite d'usage : pause, pas échec. La file (ou l'utilisateur) reprendra la session plus tard.
    const resetsAt = rateLimited.get(runId);
    await sessions.get(runId)?.stop();
    sessions.delete(runId);
    await setState(runId, "paused");
    await log(runId, "rate_limit", `run en pause${resetsAt ? ` jusqu'à ${new Date(resetsAt).toLocaleTimeString("fr-FR")}` : ""}`);
    return;
  }
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
    await armReplyTimeout(run, `Question de l'agent :\n${result.text.slice(0, 1200)}`);
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
  await deliver(run, commits);
}

/** Tâches couvertes par au moins un commit `[CU-<id>]`. Une tâche seule est couverte par tout commit. */
function coveredTasks(run: Run, commits: git.Commit[]) {
  if (run.task_ids.length === 1) return run.task_ids;
  return run.task_ids.filter((id) => commits.some((c) => c.subject.includes(`CU-${id}`)));
}

async function verify(run: Run) {
  const project = await db.getProject(run.list_id);
  if (!project?.verify_command) return true;
  await log(run.id, "git", `vérification : ${project.verify_command}`);
  const v = await git.runVerify(run.worktree_path!, project.verify_command);
  if (!v.ok) await block(run, `La vérification a échoué :\n${v.output}`);
  return v.ok;
}

async function deliver(run: Run, commits: git.Commit[]) {
  await setState(run.id, "pushing");
  const covered = coveredTasks(run, commits);
  for (const id of run.task_ids.filter((t) => !covered.includes(t))) {
    await log(run.id, "warn", `aucun commit ne porte l'ID CU-${id} : son statut ne change pas`);
  }
  if (!(await verify(run))) return;
  try {
    if (run.git_strategy === "direct-main") await deliverDirect(run, commits, covered);
    else await deliverBranch(run, commits, covered);
  } catch (e) {
    await block(run, (e as Error).message);
  }
}

function commitLines(commits: git.Commit[]) {
  return ["Commits :", ...commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.subject}`)];
}

async function deliverDirect(run: Run, commits: git.Commit[], covered: string[]) {
  const sha = await git.rebaseAndPush(run.worktree_path!, run.base_branch);
  await setState(run.id, "done", { pushed_commit: sha });
  await log(run.id, "git", `poussé sur ${run.base_branch} (${sha.slice(0, 7)})`);
  const web = await git.remoteWebUrl(run.repo_path);
  const comment = [
    `Codbot : poussé sur ${run.base_branch}.`,
    "",
    ...commitLines(commits),
    web ? `\n${web}/commit/${sha}` : "",
    "",
    "Résumé de l'agent :",
    (run.summary ?? "").slice(0, 1500),
  ].join("\n");
  await syncStatus(run, "done", comment, covered);
  await finish(run);
  await notify("Codbot : poussé", run.task_names.join(", "));
}

async function deliverBranch(run: Run, commits: git.Commit[], covered: string[]) {
  const sha = await git.pushBranch(run.worktree_path!, run.branch!);
  await log(run.id, "git", `branche ${run.branch} poussée (${sha.slice(0, 7)})`);
  const firstPush = !run.pr_url;
  let prUrl = run.pr_url;
  if (!prUrl) {
    const title = run.task_ids.length === 1
      ? `${run.task_names[0]} [CU-${run.task_ids[0]}]`
      : `${run.task_names[0]} (+${run.task_ids.length - 1}) [${run.task_ids.map((id) => `CU-${id}`).join(", ")}]`;
    const tasksMd = run.task_ids.map((id, i) => `- [${run.task_names[i]}](https://app.clickup.com/t/${id}) (CU-${id})`);
    const body = ["Tâches ClickUp :", ...tasksMd, "", "Résumé de l'agent :", "", run.summary ?? "", "", "_PR ouverte par Codbot._"].join("\n");
    try {
      prUrl = await gh.createPr(run.repo_path, { base: run.base_branch, head: run.branch!, title, body });
      await log(run.id, "git", `PR ouverte : ${prUrl}`);
    } catch (e) {
      // Remote hors GitHub ou gh indisponible : le merge sera détecté via git.
      await log(run.id, "warn", `PR non ouverte (${(e as Error).message}). Le merge de ${run.branch} sera détecté via git.`);
    }
  }
  await setState(run.id, "in_review", { pushed_commit: sha, pr_url: prUrl });
  run.pr_url = prUrl;
  run.pushed_commit = sha;
  // Le statut « en revue » n'est appliqué qu'aux tâches qui ne l'ont pas déjà.
  const toReview = covered.filter((id) => run.task_progress[id] !== "review");
  if (toReview.length) {
    const comment = [
      `Codbot : branche ${run.branch} poussée${prUrl ? ", PR ouverte" : ""}.`,
      prUrl ? prUrl : "",
      "",
      ...commitLines(commits),
    ].join("\n");
    await syncStatus(run, "review", comment, toReview);
  }
  // L'agent a fini son tour : on libère le processus, la session reste reprenable pour des corrections.
  await sessions.get(run.id)?.stop();
  sessions.delete(run.id);
  await syncKeepAwake();
  await notify(firstPush ? "Codbot : PR prête à relire" : "Codbot : PR mise à jour", run.task_names.join(", "));
}

// ---------- surveillance des PR en revue ----------

export async function checkReview(runId: string) {
  const run = await db.getRun(runId);
  if (!run || run.state !== "in_review" || !run.pushed_commit) return;
  if (run.pr_url) {
    const pr = await gh.prState(run.repo_path, run.pr_url);
    if (pr.state === "MERGED") return markMerged(run);
    if (pr.state === "CLOSED") return block(run, `La PR a été fermée sans merge : ${run.pr_url}`);
    return;
  }
  if (await git.isMergedInto(run.repo_path, run.pushed_commit, run.base_branch)) await markMerged(run);
}

async function markMerged(run: Run) {
  await setState(run.id, "done");
  await log(run.id, "git", `${run.pr_url ? "PR mergée" : `branche ${run.branch} mergée`} dans ${run.base_branch}`);
  const reviewed = run.task_ids.filter((id) => run.task_progress[id] === "review");
  await syncStatus(run, "done", `Codbot : ${run.pr_url ? `PR mergée (${run.pr_url})` : `branche ${run.branch} mergée`} dans ${run.base_branch}.`, reviewed);
  await finish(run);
  if (run.branch) await git.deleteLocalBranch(run.repo_path, run.branch);
  await notify("Codbot : PR mergée", run.task_names.join(", "));
}

let polling = false;
async function pollReviews() {
  if (polling) return;
  polling = true;
  try {
    for (const run of await db.listRuns()) {
      if (run.state !== "in_review") continue;
      await checkReview(run.id).catch((e) => log(run.id, "warn", `vérification du merge : ${(e as Error).message}`));
    }
  } finally {
    polling = false;
  }
}

// ---------- délai de réponse (runs lancés par la file) ----------

/** Sans réponse dans le délai réglé, le run passe en « Bloqué » et libère sa place dans la file. */
async function armReplyTimeout(run: Run, question: string) {
  if (!run.queue_session) return;
  const minutes = await db.getSetting<number>("question_timeout_min", 10);
  const since = (await db.getRun(run.id))?.state;
  window.clearTimeout(timeouts.get(run.id));
  const timer = window.setTimeout(async () => {
    timeouts.delete(run.id);
    const now = await db.getRun(run.id);
    if (!now || now.state !== since) return;
    for (const p of [...permissions.values()].filter((x) => x.runId === run.id)) {
      permissions.delete(p.id);
      await invoke("resolve_hook", { id: p.id, behavior: "deny", reason: "Pas de réponse dans le délai" });
    }
    await block(now, `Pas de réponse en ${minutes} min.\n\n${question}`);
  }, minutes * 60_000);
  timeouts.set(run.id, timer);
}

// ---------- blocages et fin ----------

async function block(run: Run, reason: string) {
  // Un run bloqué libère sa place : le processus s'arrête, la session reste reprenable.
  await sessions.get(run.id)?.stop();
  sessions.delete(run.id);
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
  const run = await db.getRun(runId);
  if (run) await releaseLocks(run);
}

/** Le run est fini (terminé ou abandonné) : les autres PC peuvent reprendre ses tâches. */
async function releaseLocks(run: Run) {
  for (const id of run.task_ids) await lock.release(id);
}

async function finish(run: Run) {
  await sessions.get(run.id)?.stop();
  sessions.delete(run.id);
  await git.removeWorktree(run.repo_path, run.worktree_path!);
  await releaseLocks(run);
  await syncKeepAwake();
}

// ---------- actions de l'utilisateur ----------

export async function sendMessage(runId: string, text: string) {
  const run = await db.getRun(runId);
  if (!run) return;
  rateLimited.delete(runId);
  window.clearTimeout(timeouts.get(runId));
  const session = sessions.get(runId);
  if (session?.running) {
    await session.send(text);
    await setState(runId, "running");
  } else {
    await startSession(run, text, Boolean(run.session_id));
  }
  // Une demande de correction pendant la revue ne fait pas repasser les tâches « en cours ».
  if (run.state !== "in_review") await syncStatus(run, "started");
}

export async function resumeRun(runId: string) {
  await sendMessage(runId, "Reprends là où tu t'étais arrêté, puis termine en suivant les consignes de départ.");
}

export async function stopRun(runId: string) {
  await sessions.get(runId)?.stop();
  sessions.delete(runId);
  await setState(runId, "stopped");
}

/** Revérifie les commits et retente la vérification et la livraison (après correction manuelle, par exemple). */
export async function retryDeliver(runId: string) {
  const run = await db.getRun(runId);
  if (!run?.worktree_path || !run.base_commit) return;
  const commits = await git.commitsSince(run.worktree_path, run.base_commit);
  if (!commits.length) throw new Error("Aucun commit à pousser.");
  await deliver(run, commits);
}

/** Remet le statut d'avant le run sur les tâches que le run n'a pas terminées. */
async function restoreStatuses(run: Run) {
  const mode = await db.getSetting<"auto" | "manual">("status_mode", "auto");
  for (const [i, taskId] of run.task_ids.entries()) {
    const initial = run.task_initial_status[taskId];
    if (!initial || run.task_progress[taskId] === "done") continue;
    const s: Suggestion = {
      id: crypto.randomUUID(),
      runId: run.id,
      taskId,
      taskName: run.task_names[i],
      event: "started",
      status: initial,
      comment: `Codbot : run abandonné, statut remis à « ${initial} ».`,
    };
    if (mode === "auto") await applySuggestion(s);
    else suggestions.set(s.id, s);
  }
  changed();
}

export async function abandonRun(runId: string) {
  const run = await db.getRun(runId);
  if (!run) return;
  for (const s of [...suggestions.values()]) if (s.runId === runId) suggestions.delete(s.id);
  await sessions.get(runId)?.stop();
  sessions.delete(runId);
  if (run.worktree_path) await git.removeWorktree(run.repo_path, run.worktree_path);
  // Une branche jamais poussée n'existe que localement : on la supprime avec le worktree.
  if (run.branch && !run.pushed_commit) await git.deleteLocalBranch(run.repo_path, run.branch);
  await setState(runId, "failed", { error: "Abandonné par l'utilisateur" });
  await restoreStatuses(run);
  await releaseLocks(run);
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
  if (await db.getSetting<boolean>("unattended", false)) {
    const project = await db.getProject(run.list_id);
    // Liste vide : liste par défaut (git en local, lecture, npm test/run, node…).
    const list = project?.allowlist.length ? project.allowlist : DEFAULT_ALLOWLIST;
    const d = decideUnattended(list, tool, input);
    await invoke("resolve_hook", { id: h.id, behavior: d.allow ? "allow" : "deny", reason: `Codbot, sans surveillance : ${d.reason}` });
    await log(run.id, "permission", `${d.allow ? "autorisé" : "refusé"} automatiquement : ${tool} (${d.reason})`);
    return;
  }
  const p: Permission = { id: h.id, runId: run.id, tool, input, at: Date.now() };
  permissions.set(p.id, p);
  await setState(run.id, "waiting_permission");
  await log(run.id, "permission", `demande : ${tool} ${JSON.stringify(input).slice(0, 200)}`);
  await armReplyTimeout(run, `Permission demandée : ${tool} ${JSON.stringify(input).slice(0, 600)}`);
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
  window.clearTimeout(timeouts.get(p.runId));
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
  // Ceux de la file passent « en pause » : la file les reprendra en priorité.
  for (const run of await db.listRuns()) {
    if (ACTIVE_STATES.includes(run.state)) {
      const paused = Boolean(run.queue_session && run.session_id);
      await db.updateRun(run.id, { state: paused ? "paused" : "stopped" });
      await db.addRunEvent(run.id, "info", `Codbot a redémarré : run ${paused ? "en pause, repris par la file" : "arrêté, reprise possible"}`);
    }
  }
  void pollReviews();
  setInterval(() => void pollReviews(), REVIEW_POLL_MS);
}
