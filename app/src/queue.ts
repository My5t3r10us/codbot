// File d'attente : enchaîne les runs dans l'ordre, dans la limite de concurrence,
// met tout en pause sur la limite d'usage de l'abonnement et produit un rapport.
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import * as cu from "./clickup";
import * as db from "./db";
import * as lock from "./lock";
import * as runs from "./runs";

const TICK_MS = 15_000;
/** Pause par défaut quand le flux ne donne pas l'heure de réinitialisation. */
const DEFAULT_PAUSE_MS = 30 * 60_000;

export type QueueStatus = {
  running: boolean;
  pausedUntil: number | null;
  sessionId: string | null;
};

const listeners = new Set<() => void>();
export function onQueueChange(fn: () => void) {
  listeners.add(fn);
}
function changed() {
  for (const fn of listeners) fn();
}

export async function status(): Promise<QueueStatus> {
  return {
    running: await db.getSetting("queue_running", false),
    pausedUntil: await db.getSetting<number | null>("queue_paused_until", null),
    sessionId: await db.getSetting<string | null>("queue_session", null),
  };
}

// ---------- ajout ----------

/** Ajoute des tâches à la file. En mode séparé, une entrée par tâche. */
export async function add(tasks: cu.CuTask[], project: db.Project, opts: runs.LaunchOptions) {
  // Le mode séparé à plusieurs tâches impose une branche par tâche (même règle qu'au lancement direct).
  const strategy = opts.mode === "separe" && tasks.length > 1 ? "branche" : opts.strategy;
  const groups = opts.mode === "groupe" ? [tasks] : tasks.map((t) => [t]);
  for (const group of groups) {
    await db.enqueue({
      id: crypto.randomUUID(),
      list_id: project.list_id,
      task_ids: group.map((t) => t.id),
      task_names: group.map((t) => t.name),
      mode: opts.mode,
      strategy,
      brief: groups.length === 1 ? (opts.brief ?? null) : null,
    });
  }
  changed();
  void tick();
}

export async function remove(id: string) {
  await db.dequeue(id);
  changed();
}

export async function reorder(ids: string[]) {
  await db.reorderQueue(ids);
  changed();
}

// ---------- marche / arrêt ----------

export async function start() {
  const st = await status();
  if (!st.sessionId) await db.setSetting("queue_session", (await db.startQueueSession()).id);
  await db.setSetting("queue_running", true);
  await runs.setQueueActive(true);
  changed();
  void tick();
}

/** Arrête de lancer de nouveaux runs ; ceux en cours continuent. */
export async function stop() {
  await db.setSetting("queue_running", false);
  await runs.setQueueActive(false);
  changed();
}

async function finishSession(sessionId: string) {
  await db.endQueueSession(sessionId);
  await db.setSetting("queue_session", null);
  await db.setSetting("queue_running", false);
  await db.setSetting("queue_paused_until", null);
  await runs.setQueueActive(false);
  const report = await reportFor(sessionId);
  if (await isPermissionGranted()) {
    sendNotification({ title: "Codbot : file terminée", body: report.headline });
  }
  changed();
}

// ---------- boucle ----------

let ticking = false;

export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await step();
  } finally {
    ticking = false;
  }
}

async function step() {
  const st = await status();
  if (!st.running || !st.sessionId) return;

  if (st.pausedUntil) {
    if (Date.now() < st.pausedUntil) return;
    await db.setSetting("queue_paused_until", null);
    changed();
  }

  const all = await db.listRuns(500);
  const active = all.filter((r) => runs.ACTIVE_STATES.includes(r.state));
  let free = (await db.getSetting<number>("concurrency", 2)) - active.length;

  // 1. Reprendre d'abord les runs de la file mis en pause (limite d'usage, redémarrage de l'app).
  for (const run of all.filter((r) => r.state === "paused" && r.queue_session === st.sessionId)) {
    if (free <= 0) break;
    await runs.resumeRun(run.id);
    free--;
  }

  // 2. Lancer les éléments suivants, dans l'ordre, en respectant les règles git par repo.
  const busyRepos = new Set(active.map((r) => r.repo_path));
  const directRepos = new Set(active.filter((r) => r.git_strategy === "direct-main").map((r) => r.repo_path));
  for (const item of await db.listQueue()) {
    if (free <= 0) break;
    const project = await db.getProject(item.list_id);
    if (!project?.repo_path) continue;
    // Un direct-main attend que le repo soit libre ; une branche attend seulement qu'aucun direct-main n'y tourne.
    if (item.strategy === "direct-main" ? busyRepos.has(project.repo_path) : directRepos.has(project.repo_path)) continue;
    // Une tâche prise par un autre PC reste dans la file : elle sera relancée quand le verrou tombera.
    const tasks = await Promise.all(item.task_ids.map((id) => cu.getTask(id)));
    if ((await Promise.all(tasks.map((t) => lock.lockedByOther(t)))).some(Boolean)) continue;
    await db.dequeue(item.id);
    changed();
    await runs.launchQueued(item, project, st.sessionId);
    busyRepos.add(project.repo_path);
    if (item.strategy === "direct-main") directRepos.add(project.repo_path);
    free--;
  }

  // 3. File vide et plus aucun run de la session en cours de travail : fin de session.
  const left = await db.listQueue();
  const mine = (await db.runsOfQueueSession(st.sessionId)).filter((r) => runs.ACTIVE_STATES.includes(r.state) || r.state === "paused");
  if (!left.length && !mine.length) await finishSession(st.sessionId);
}

/** Limite d'usage atteinte par un agent : toute la file attend la réinitialisation. */
runs.onRateLimitHit(async (resetsAt) => {
  const until = resetsAt && resetsAt > Date.now() ? resetsAt + 60_000 : Date.now() + DEFAULT_PAUSE_MS;
  const current = await db.getSetting<number | null>("queue_paused_until", null);
  if (!current || until > current) await db.setSetting("queue_paused_until", until);
  changed();
});

// ---------- rapport ----------

export type Report = {
  session: db.QueueSession;
  headline: string;
  runs: db.Run[];
  counts: Record<string, number>;
};

export async function reportFor(sessionId: string): Promise<Report> {
  const session = (await db.getQueueSession(sessionId))!;
  const list = await db.runsOfQueueSession(sessionId);
  const counts: Record<string, number> = {};
  for (const r of list) counts[r.state] = (counts[r.state] ?? 0) + 1;
  const parts = [
    counts.done ? `${counts.done} terminé(s)` : "",
    counts.in_review ? `${counts.in_review} en revue` : "",
    counts.blocked ? `${counts.blocked} bloqué(s)` : "",
    counts.failed ? `${counts.failed} en échec` : "",
    counts.paused ? `${counts.paused} en pause` : "",
  ].filter(Boolean);
  return { session, runs: list, counts, headline: parts.join(", ") || "aucun run" };
}

export async function lastReport() {
  const s = await db.lastQueueSession();
  return s ? reportFor(s.id) : null;
}

export async function init() {
  // Après un redémarrage, l'anti-veille et la boucle reprennent si la file tournait.
  if ((await status()).running) await runs.setQueueActive(true);
  // Chaque changement de run peut libérer une place ; on regroupe les réveils.
  let soon: number | undefined;
  runs.onChange(() => {
    window.clearTimeout(soon);
    soon = window.setTimeout(() => void tick(), 1000);
  });
  setInterval(() => void tick(), TICK_MS);
  void tick();
}
