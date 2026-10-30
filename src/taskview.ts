// Petites règles d'affichage des tâches (pures, testées).
import type { CuTask } from "./clickup";

export type DueTone = "err" | "warn" | "normal" | "muted";

/** Libellé court d'une échéance ClickUp (ms en chaîne) : « En retard · 2 j », « Aujourd'hui », « 31 oct. ». */
export function dueInfo(due: string | null, now = new Date()): { label: string; tone: DueTone; soon: boolean } {
  if (!due) return { label: "", tone: "muted", soon: false };
  const at = new Date(Number(due));
  const day = 24 * 3600 * 1000;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const d = Math.floor((at.getTime() - start) / day);
  if (at.getTime() < now.getTime() && d < 0) return { label: `En retard · ${-d} j`, tone: "err", soon: true };
  if (d === 0) return { label: "Aujourd'hui", tone: "warn", soon: true };
  if (d === 1) return { label: "Demain", tone: "normal", soon: true };
  const label = at.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  return { label, tone: "normal", soon: d < 7 };
}

/** Niveau de priorité : 4 urgent, 3 haute, 2 normale, 1 basse, 0 aucune. */
export function priorityLevel(task: Pick<CuTask, "priority">) {
  return ({ urgent: 4, high: 3, normal: 2, low: 1 } as Record<string, number>)[task.priority?.priority ?? ""] ?? 0;
}

export const PRIORITY_LABEL = ["sans priorité", "basse", "normale", "haute", "urgente"];

/** Initiales d'un membre ClickUp. */
export function initials(u: { username: string; initials?: string | null }) {
  if (u.initials) return u.initials.toUpperCase();
  const parts = u.username.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** Tâches dans l'ordre d'affichage : chaque sous-tâche juste sous sa parente (si elle est visible). */
export function withChildren(tasks: CuTask[]) {
  const ids = new Set(tasks.map((t) => t.id));
  const out: { task: CuTask; sub: boolean }[] = [];
  for (const t of tasks.filter((t) => !t.parent || !ids.has(t.parent))) {
    out.push({ task: t, sub: false });
    for (const c of tasks.filter((c) => c.parent === t.id)) out.push({ task: c, sub: true });
  }
  return out;
}
