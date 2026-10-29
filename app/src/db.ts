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
};

export type RunState =
  | "preparing"
  | "running"
  | "waiting_permission"
  | "waiting_reply"
  | "pushing"
  | "in_review"
  | "done"
  | "blocked"
  | "failed"
  | "stopped";

export type GitStrategy = "direct-main" | "branche";
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
  return (await conn()).select<Project[]>("SELECT * FROM projects ORDER BY list_name");
}

export async function getProject(listId: string) {
  const rows = await (await conn()).select<Project[]>("SELECT * FROM projects WHERE list_id = $1", [listId]);
  return rows[0] ?? null;
}

export async function saveProject(p: Project) {
  await (await conn()).execute(
    `INSERT INTO projects (list_id, list_name, repo_path, base_branch, verify_command) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(list_id) DO UPDATE SET list_name = excluded.list_name, repo_path = excluded.repo_path,
       base_branch = excluded.base_branch, verify_command = excluded.verify_command`,
    [p.list_id, p.list_name, p.repo_path, p.base_branch, p.verify_command],
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
       task_initial_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      run.id, JSON.stringify(run.task_ids), JSON.stringify(run.task_names), run.list_id, run.repo_path,
      run.worktree_path, run.base_branch, run.git_strategy, run.session_id, run.state, run.base_commit,
      run.pushed_commit, run.summary, run.error, run.created_at, run.ended_at, run.mode, run.branch, run.pr_url,
      JSON.stringify(run.task_progress), JSON.stringify(run.task_initial_status),
    ],
  );
}

const RUN_FIELDS = [
  "worktree_path", "session_id", "state", "base_commit", "pushed_commit", "summary", "error", "ended_at",
  "branch", "pr_url", "task_progress",
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
