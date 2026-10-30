// Accès SQLite (plugin sql) : réglages, projets, correspondance des statuts, runs.
import Database from "@tauri-apps/plugin-sql";

export type StatusEvent = "started" | "blocked" | "review" | "done";
export const STATUS_EVENTS: { event: StatusEvent; label: string }[] = [
  { event: "started", label: "Run démarré" },
  { event: "blocked", label: "Question, permission ou erreur en attente" },
  { event: "review", label: "Branche poussée / PR ouverte" },
  { event: "done", label: "Poussé sur la branche principale" },
];

export type Project = {
  list_id: string;
  list_name: string;
  repo_path: string;
  base_branch: string;
  verify_command: string | null;
  /** Motifs autorisés en mode sans surveillance, ex. "Bash(npm test*)", "WebFetch". */
  allowlist: string[];
};

type ProjectRow = Omit<Project, "allowlist"> & { allowlist: string };
const toProject = (r: ProjectRow): Project => ({ ...r, allowlist: JSON.parse(r.allowlist || "[]") });

export type RunState =
  | "preparing"
  | "running"
  | "waiting_permission"
  | "waiting_reply"
  | "pushing"
  | "in_review"
  | "paused"
  | "done"
  | "blocked"
  | "failed"
  | "stopped";

export type GitStrategy = "direct-main" | "branche";
export type StatusMode = "auto" | "manual";
export type RunMode = "separe" | "groupe";

export type Run = {
  id: string;
  task_ids: string[];
  task_names: string[];
  list_id: string;
  repo_path: string;
  worktree_path: string | null;
  base_branch: string;
  git_strategy: GitStrategy;
  mode: RunMode;
  branch: string | null;
  pr_url: string | null;
  /** Dernier événement de statut appliqué à chaque tâche. */
  task_progress: Record<string, StatusEvent>;
  /** Statut ClickUp de chaque tâche au lancement, remis en place si le run est abandonné. */
  task_initial_status: Record<string, string>;
  session_id: string | null;
  state: RunState;
  base_commit: string | null;
  pushed_commit: string | null;
  summary: string | null;
  error: string | null;
  created_at: string;
  ended_at: string | null;
  /** Session de file d'attente qui a lancé ce run (null : lancé à la main). */
  queue_session: string | null;
  /** Mode des statuts choisi au lancement (null : réglage global). */
  status_mode: StatusMode | null;
  /** Modèle et effort passés à Claude Code (null : défaut du CLI). */
  model: string | null;
  effort: string | null;
};

export type RunEvent = { id: number; run_id: string; type: string; text: string; at: string };

let db: Database | null = null;
async function conn() {
  db ??= await Database.load("sqlite:codbot.db");
  return db;
}

// ---------- réglages ----------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = await (await conn()).select<{ value: string }[]>("SELECT value FROM settings WHERE key = $1", [key]);
  return rows.length ? (JSON.parse(rows[0].value) as T) : fallback;
}

export async function setSetting(key: string, value: unknown) {
  await (await conn()).execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)],
  );
}

// ---------- projets ----------

export async function listProjects() {
  return (await (await conn()).select<ProjectRow[]>("SELECT * FROM projects ORDER BY list_name")).map(toProject);
}

export async function getProject(listId: string) {
  const rows = await (await conn()).select<ProjectRow[]>("SELECT * FROM projects WHERE list_id = $1", [listId]);
  return rows.length ? toProject(rows[0]) : null;
}

export async function saveProject(p: Project) {
  await (await conn()).execute(
    `INSERT INTO projects (list_id, list_name, repo_path, base_branch, verify_command, allowlist) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(list_id) DO UPDATE SET list_name = excluded.list_name, repo_path = excluded.repo_path,
       base_branch = excluded.base_branch, verify_command = excluded.verify_command, allowlist = excluded.allowlist`,
    [p.list_id, p.list_name, p.repo_path, p.base_branch, p.verify_command, JSON.stringify(p.allowlist)],
  );
}

export async function deleteProject(listId: string) {
  const c = await conn();
  await c.execute("DELETE FROM status_mappings WHERE list_id = $1", [listId]);
  await c.execute("DELETE FROM projects WHERE list_id = $1", [listId]);
}

// ---------- correspondance des statuts ----------

export async function getMappings(listId: string): Promise<Partial<Record<StatusEvent, string>>> {
  const rows = await (await conn()).select<{ event: StatusEvent; status: string }[]>(
    "SELECT event, status FROM status_mappings WHERE list_id = $1",
    [listId],
  );
  return Object.fromEntries(rows.map((r) => [r.event, r.status]));
}

export async function setMapping(listId: string, event: StatusEvent, status: string) {
  const c = await conn();
  if (!status) {
    await c.execute("DELETE FROM status_mappings WHERE list_id = $1 AND event = $2", [listId, event]);
    return;
  }
  await c.execute(
    `INSERT INTO status_mappings (list_id, event, status) VALUES ($1, $2, $3)
     ON CONFLICT(list_id, event) DO UPDATE SET status = excluded.status`,
    [listId, event, status],
  );
}

// ---------- runs ----------

type RunRow = Omit<Run, "task_ids" | "task_names" | "task_progress" | "task_initial_status"> & {
  task_ids: string;
  task_names: string;
  task_progress: string;
  task_initial_status: string;
};
const toRun = (r: RunRow): Run => ({
  ...r,
  task_ids: JSON.parse(r.task_ids),
  task_names: JSON.parse(r.task_names),
  task_progress: JSON.parse(r.task_progress || "{}"),
  task_initial_status: JSON.parse(r.task_initial_status || "{}"),
});

export async function insertRun(run: Run) {
  await (await conn()).execute(
    `INSERT INTO runs (id, task_ids, task_names, list_id, repo_path, worktree_path, base_branch, git_strategy,
       session_id, state, base_commit, pushed_commit, summary, error, created_at, ended_at, mode, branch, pr_url, task_progress,
       task_initial_status, queue_session, status_mode, model, effort)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
    [
      run.id, JSON.stringify(run.task_ids), JSON.stringify(run.task_names), run.list_id, run.repo_path,
      run.worktree_path, run.base_branch, run.git_strategy, run.session_id, run.state, run.base_commit,
      run.pushed_commit, run.summary, run.error, run.created_at, run.ended_at, run.mode, run.branch, run.pr_url,
      JSON.stringify(run.task_progress), JSON.stringify(run.task_initial_status), run.queue_session,
      run.status_mode, run.model, run.effort,
    ],
  );
}

const RUN_FIELDS = [
  "worktree_path", "session_id", "state", "base_commit", "pushed_commit", "summary", "error", "ended_at",
  "branch", "pr_url", "task_progress", "git_strategy",
] as const;
type RunPatch = Partial<Pick<Run, (typeof RUN_FIELDS)[number]>>;

export async function updateRun(id: string, patch: RunPatch) {
  const keys = RUN_FIELDS.filter((k) => k in patch);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const value = (k: (typeof keys)[number]) => (k === "task_progress" ? JSON.stringify(patch[k]) : (patch[k] ?? null));
  await (await conn()).execute(`UPDATE runs SET ${sets} WHERE id = $1`, [id, ...keys.map(value)]);
}

export async function listRuns(limit = 100) {
  const rows = await (await conn()).select<RunRow[]>("SELECT * FROM runs ORDER BY created_at DESC LIMIT $1", [limit]);
  return rows.map(toRun);
}

export async function getRun(id: string) {
  const rows = await (await conn()).select<RunRow[]>("SELECT * FROM runs WHERE id = $1", [id]);
  return rows.length ? toRun(rows[0]) : null;
}

export async function addRunEvent(runId: string, type: string, text: string) {
  await (await conn()).execute("INSERT INTO run_events (run_id, type, text, at) VALUES ($1, $2, $3, $4)", [
    runId, type, text, new Date().toISOString(),
  ]);
}

export async function listRunEvents(runId: string) {
  return (await conn()).select<RunEvent[]>("SELECT * FROM run_events WHERE run_id = $1 ORDER BY id", [runId]);
}

// ---------- file d'attente ----------

export type QueueItem = {
  id: string;
  position: number;
  list_id: string;
  task_ids: string[];
  task_names: string[];
  mode: RunMode;
  strategy: GitStrategy;
  brief: string | null;
  status_mode: StatusMode | null;
  /** Modèle forcé au lancement ; null : choix automatique au démarrage du run. */
  model_choice: { model: string; effort: string } | null;
  added_at: string;
};

type QueueRow = Omit<QueueItem, "task_ids" | "task_names" | "model_choice"> & { task_ids: string; task_names: string; model_choice: string | null };
const toItem = (r: QueueRow): QueueItem => ({
  ...r,
  task_ids: JSON.parse(r.task_ids),
  task_names: JSON.parse(r.task_names),
  model_choice: r.model_choice ? JSON.parse(r.model_choice) : null,
});

export async function listQueue() {
  return (await (await conn()).select<QueueRow[]>("SELECT * FROM queue ORDER BY position")).map(toItem);
}

/** Ajoute en fin de file, ou à `position` pour remettre un élément à sa place. */
export async function enqueue(item: Omit<QueueItem, "position" | "added_at"> & { position?: number }) {
  const c = await conn();
  const [{ next }] = await c.select<{ next: number }[]>("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM queue");
  await c.execute(
    `INSERT INTO queue (id, position, list_id, task_ids, task_names, mode, strategy, brief, status_mode, model_choice, added_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [item.id, item.position ?? next, item.list_id, JSON.stringify(item.task_ids), JSON.stringify(item.task_names), item.mode, item.strategy,
      item.brief, item.status_mode, item.model_choice ? JSON.stringify(item.model_choice) : null, new Date().toISOString()],
  );
}

/** Retire un élément de la file. Faux s'il n'y était plus (déjà lancé ailleurs) : sert de prise exclusive. */
export async function dequeue(id: string) {
  const r = await (await conn()).execute("DELETE FROM queue WHERE id = $1", [id]);
  return r.rowsAffected > 0;
}

/** Réécrit les positions dans l'ordre donné. */
export async function reorderQueue(ids: string[]) {
  const c = await conn();
  for (const [i, id] of ids.entries()) await c.execute("UPDATE queue SET position = $1 WHERE id = $2", [i + 1, id]);
}

export type QueueSession = { id: string; started_at: string; ended_at: string | null };

export async function startQueueSession() {
  const s: QueueSession = { id: crypto.randomUUID(), started_at: new Date().toISOString(), ended_at: null };
  await (await conn()).execute("INSERT INTO queue_sessions (id, started_at) VALUES ($1, $2)", [s.id, s.started_at]);
  return s;
}

export async function endQueueSession(id: string) {
  await (await conn()).execute("UPDATE queue_sessions SET ended_at = $1 WHERE id = $2", [new Date().toISOString(), id]);
}

export async function lastQueueSession() {
  const rows = await (await conn()).select<QueueSession[]>("SELECT * FROM queue_sessions ORDER BY started_at DESC LIMIT 1");
  return rows[0] ?? null;
}

export async function runsOfQueueSession(id: string) {
  const rows = await (await conn()).select<RunRow[]>("SELECT * FROM runs WHERE queue_session = $1 ORDER BY created_at", [id]);
  return rows.map(toRun);
}

export async function getQueueSession(id: string) {
  const rows = await (await conn()).select<QueueSession[]>("SELECT * FROM queue_sessions WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listAllMappings() {
  return (await conn()).select<{ list_id: string; event: StatusEvent; status: string }[]>(
    "SELECT list_id, event, status FROM status_mappings ORDER BY list_id, event",
  );
}

/** Derniers événements de tous les runs (fil d'activité de la page Projets). */
export async function listRecentEvents(limit = 40, types: string[] = ["git", "status", "permission", "error", "steer"]) {
  const marks = types.map((_, i) => `$${i + 2}`).join(", ");
  return (await conn()).select<RunEvent[]>(
    `SELECT * FROM run_events WHERE type IN (${marks}) ORDER BY id DESC LIMIT $1`,
    [limit, ...types],
  );
}

/** Dernier événement de chaque run parmi les types donnés (activité affichée sur les cartes). */
export async function latestEvents(runIds: string[], types = ["tool", "agent", "todos", "permission", "git"]) {
  if (!runIds.length) return [] as RunEvent[];
  const ids = runIds.map((_, i) => `$${i + 1}`).join(", ");
  const kinds = types.map((_, i) => `$${runIds.length + i + 1}`).join(", ");
  return (await conn()).select<RunEvent[]>(
    `SELECT e.* FROM run_events e JOIN (SELECT run_id, MAX(id) AS id FROM run_events WHERE run_id IN (${ids}) AND type IN (${kinds}) GROUP BY run_id) m ON m.id = e.id`,
    [...runIds, ...types],
  );
}

/** Dernier plan (événement « todos ») de chaque run. */
export async function latestPlans(runIds: string[]) {
  return latestEvents(runIds, ["todos"]);
}

/** Événements de certains types pour plusieurs runs, dans l'ordre (arbre des agents). */
export async function eventsOfRuns(runIds: string[], types: string[]) {
  if (!runIds.length) return [] as RunEvent[];
  const ids = runIds.map((_, i) => `$${i + 1}`).join(", ");
  const kinds = types.map((_, i) => `$${runIds.length + i + 1}`).join(", ");
  return (await conn()).select<RunEvent[]>(
    `SELECT * FROM run_events WHERE run_id IN (${ids}) AND type IN (${kinds}) ORDER BY id`,
    [...runIds, ...types],
  );
}
