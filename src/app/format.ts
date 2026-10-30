// Mise en forme partagée par les vues (durées, activité d'un agent).
import type { RunEvent, Run } from "../db";
import type { Todo } from "../live";

export const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function dur(ms: number) {
  const s = Math.max(0, ms / 1000);
  if (s < 60) return `${s < 10 ? s.toFixed(1).replace(".", ",") : Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)}`;
}

export function ago(iso: string | number, now = Date.now()) {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  const d = new Date(t);
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

/** Outil + cible lisible depuis une ligne de journal « Edit {"file_path": …} ». */
export function toolText(text: string) {
  const name = text.split(" ")[0] ?? "";
  const grab = (key: string) => text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))?.[1]?.replace(/\\\\/g, "\\");
  const file = grab("file_path") ?? grab("notebook_path") ?? grab("path");
  const target = file ? basename(file) : grab("command") ?? grab("pattern") ?? grab("description") ?? grab("url") ?? "";
  return { name, target: target.slice(0, 90) };
}

export function parseTodos(text: string): Todo[] {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Phrase courte qui dit ce que fait l'agent d'un run, à partir de son dernier événement. */
export function activityText(run: Run, ev: RunEvent | undefined) {
  switch (run.state) {
    case "waiting_permission": return "Attend ton accord";
    case "waiting_reply": return "Attend ta réponse";
    case "blocked": return `Bloqué · ${(run.error ?? "").split("\n")[0].slice(0, 80)}`;
    case "in_review": return run.pr_url ? "En revue · PR ouverte" : "En revue";
    case "paused": return "En pause";
    case "stopped": return "Arrêté, reprise possible";
    case "pushing": return "Vérifie et pousse les commits";
    case "preparing": return "Prépare le worktree";
  }
  if (!ev) return "Démarre…";
  if (ev.type === "todos") {
    const cur = parseTodos(ev.text).find((t) => t.status === "in_progress");
    return cur ? cur.activeForm ?? cur.content : "Planifie";
  }
  if (ev.type === "tool") {
    const t = toolText(ev.text);
    return `${t.name} ${t.target}`.trim();
  }
  if (ev.type === "agent") return ev.text.split("\n")[0].slice(0, 100);
  return ev.text.slice(0, 100);
}

/** Avancement du plan (0 → 1), ou null sans plan. */
export function planProgress(ev: RunEvent | undefined) {
  if (!ev) return null;
  const todos = parseTodos(ev.text);
  if (!todos.length) return null;
  return todos.filter((t) => t.status === "completed").length / todos.length;
}
