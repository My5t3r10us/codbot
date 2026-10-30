// Libellés et tons des états de run, partagés par les vues.
import type { RunState } from "./db";

export const STATE_LABEL: Record<RunState, string> = {
  preparing: "préparation",
  running: "en cours",
  waiting_permission: "attend une permission",
  waiting_reply: "attend une réponse",
  pushing: "push en cours",
  in_review: "en revue",
  paused: "en pause",
  done: "terminé",
  blocked: "bloqué",
  failed: "échec",
  stopped: "arrêté",
};

export type Tone = "run" | "wait" | "err" | "ok" | "rev" | "muted";

export const STATE_TONE: Record<RunState, Tone> = {
  preparing: "run",
  running: "run",
  waiting_permission: "wait",
  waiting_reply: "wait",
  pushing: "run",
  in_review: "rev",
  paused: "muted",
  done: "ok",
  blocked: "err",
  failed: "err",
  stopped: "muted",
};

/** États où l'utilisateur doit décider quelque chose. */
export const NEEDS_YOU: RunState[] = ["waiting_permission", "waiting_reply", "blocked", "stopped"];

/** États où le run n'est pas clos : sa tâche est « prise ». */
export const OPEN_STATES: RunState[] = ["preparing", "running", "waiting_permission", "waiting_reply", "pushing", "in_review", "paused", "blocked", "stopped"];

/** Humeur du petit visage d'agent selon l'état du run. */
export function moodOf(state: RunState): "run" | "wait" | "err" | "sleep" | "idle" {
  const tone = STATE_TONE[state];
  return tone === "run" ? "run" : tone === "wait" ? "wait" : tone === "err" ? "err" : state === "paused" || state === "stopped" ? "sleep" : "idle";
}

/** Couleur CSS d'un ton. */
export const TONE_COLOR: Record<Tone, string> = {
  run: "var(--brand)", wait: "var(--warn)", err: "var(--err)", ok: "var(--ok)", rev: "var(--rev)", muted: "var(--faint)",
};
