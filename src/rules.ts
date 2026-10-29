// Règles métier pures (sans Tauri ni réseau) : testées par vitest dans tests/.
import type { CuTask } from "./clickup";
import type { GitStrategy, RunMode, RunState } from "./db";

/** États où un agent travaille (ou va travailler) dans le worktree. */
export const ACTIVE_STATES: RunState[] = ["preparing", "running", "waiting_permission", "waiting_reply", "pushing"];

/** Tag ClickUp qui propose direct-main par défaut. */
export const SMALL_TAG = "small";

// ---------- règle de stratégie git (§5.5 de la spec) ----------

export type StrategyChoice = { forced: GitStrategy | null; suggested: GitStrategy; reason: string };

/**
 * L'agent ne choisit jamais : mode séparé à plusieurs tâches ou run déjà actif sur le repo → branche
 * imposée ; sinon commit direct proposé si une tâche porte le tag « small », branche sinon.
 */
export function strategyRule(
  tasks: Pick<CuTask, "tags">[],
  mode: RunMode,
  busyRun: { task_names: string[] } | null,
  baseBranch: string,
): StrategyChoice {
  if (mode === "separe" && tasks.length > 1) {
    return { forced: "branche", suggested: "branche", reason: "Plusieurs agents en parallèle : une branche par tâche." };
  }
  if (busyRun) {
    return { forced: "branche", suggested: "branche", reason: `Un run est déjà actif sur ce repo (${busyRun.task_names.join(", ")}).` };
  }
  const small = tasks.some((t) => t.tags.some((tag) => tag.name.toLowerCase() === SMALL_TAG));
  return small
    ? { forced: null, suggested: "direct-main", reason: `Tag « ${SMALL_TAG} » : commit direct sur ${baseBranch} proposé.` }
    : { forced: null, suggested: "branche", reason: "Par défaut : branche et PR (tag « small » pour un commit direct)." };
}

/** File d'attente : un direct-main attend que le repo soit libre, une branche qu'aucun direct-main n'y tourne. */
export function repoAllows(
  strategy: GitStrategy,
  repo: string,
  active: { repo_path: string; git_strategy: GitStrategy }[],
) {
  return strategy === "direct-main"
    ? !active.some((r) => r.repo_path === repo)
    : !active.some((r) => r.repo_path === repo && r.git_strategy === "direct-main");
}

// ---------- brief ----------

/** Repères du brief prévisualisé avant le lancement, remplacés par les vraies valeurs. */
export const BRIEF_WORKTREE = "(dossier du worktree, créé au lancement)";
export const BRIEF_BRANCH = "(cu/<id>-<titre>)";

function taskSection(task: CuTask, heading: string) {
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

export function buildBrief(tasks: CuTask[], ctx: { worktree: string; base: string; branch: string | null }) {
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

/** Remplace les repères d'un brief modifié à la main par le vrai worktree et la vraie branche. */
export function fillBrief(brief: string, worktree: string, branch: string | null) {
  return brief.split(BRIEF_WORKTREE).join(worktree).split(BRIEF_BRANCH).join(branch ?? "");
}

// ---------- commits ----------

/** Tâches couvertes par au moins un commit `[CU-<id>]`. Une tâche seule est couverte par tout commit. */
export function coveredTasks(taskIds: string[], commits: { subject: string }[]) {
  if (taskIds.length === 1) return commits.length ? taskIds : [];
  return taskIds.filter((id) => commits.some((c) => c.subject.includes(`CU-${id}`)));
}

// ---------- limite d'usage ----------

export type RateLimit = { text: string; resetsAt: number | null };

/**
 * Message du flux stream-json qui signale une limite atteinte, ou null.
 * Le flux émet un `rate_limit_event` à chaque requête : seul un statut autre que « allowed » compte.
 */
export function rateLimitFrom(msg: Record<string, any>): RateLimit | null {
  if (msg.type === "rate_limit_event") {
    const info = msg.rate_limit_info ?? {};
    if (info.status === "allowed") return null;
    return { text: JSON.stringify(info).slice(0, 400), resetsAt: info.resetsAt ? Number(info.resetsAt) * 1000 : null };
  }
  if (msg.error && /rate_limit|usage_limit/i.test(String(msg.error))) return { text: JSON.stringify(msg).slice(0, 400), resetsAt: null };
  if (msg.type === "result" && msg.is_error && /limit|quota/i.test(String(msg.result))) return { text: String(msg.result), resetsAt: null };
  return null;
}

// ---------- usage de l'abonnement ----------

export type UsageWindow = { name: string; utilization: number; resetsAt: number | null; status: string };
export type Usage = { windows: UsageWindow[]; at: number };

const WINDOW_LABELS: Record<string, string> = { five_hour: "5 h", seven_day: "7 j" };

/** Usage par fenêtre (5 h, 7 j…) tiré d'un `rate_limit_event`, utilisation entre 0 et 1. */
export function usageFrom(msg: Record<string, any>, now = Date.now()): Usage | null {
  if (msg.type !== "rate_limit_event") return null;
  const windows = Object.entries<Record<string, any>>(msg.rate_limit_info?.unifiedWindows ?? {}).map(([key, w]) => ({
    name: WINDOW_LABELS[key] ?? key,
    utilization: Number(w.utilization ?? 0),
    resetsAt: w.resetsAt ? Number(w.resetsAt) * 1000 : null,
    status: String(w.status ?? ""),
  }));
  return windows.length ? { windows, at: now } : null;
}

// ---------- filtre d'échéance (vue Tâches) ----------

export type DueFilter = "all" | "overdue" | "today" | "week" | "none";

/** `due` : échéance ClickUp en millisecondes (chaîne), ou null. */
export function matchesDue(due: string | null, filter: DueFilter, now = new Date()) {
  if (filter === "all") return true;
  if (filter === "none") return !due;
  if (!due) return false;
  const at = Number(due);
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 3600 * 1000;
  if (filter === "overdue") return at < now.getTime();
  if (filter === "today") return at >= startOfDay && at < startOfDay + day;
  return at >= startOfDay && at < startOfDay + 7 * day;
}
