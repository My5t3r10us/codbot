// Suivi « en direct » d'un run reconstruit depuis le flux stream-json : plan de l'agent
// (TodoWrite / TaskCreate / TaskUpdate) et sous-agents (outil Task / Agent). Fonctions pures, testées.

export type TodoStatus = "pending" | "in_progress" | "completed";
export type Todo = { content: string; status: TodoStatus; activeForm?: string };
export type PlanItem = Todo & { startedAt: number | null; endedAt: number | null };

export type SubagentStatus = "running" | "done" | "error";
export type Subagent = {
  id: string;
  type: string;
  description: string;
  status: SubagentStatus;
  startedAt: number;
  endedAt: number | null;
};

/** Outils qui lancent un sous-agent dans Claude Code. */
export const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

const asStatus = (s: unknown): TodoStatus | null =>
  s === "pending" || s === "in_progress" || s === "completed" ? s : null;

/**
 * Nouveau plan après un appel d'outil de l'agent, ou null si l'outil ne touche pas au plan.
 * TodoWrite remplace toute la liste ; TaskCreate / TaskUpdate (numérotées à partir de 1) la modifient.
 */
export function todosFromToolUse(name: string, input: Record<string, any>, current: Todo[]): Todo[] | null {
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    return input.todos
      .map((t: Record<string, any>) => ({
        content: String(t.content ?? t.subject ?? ""),
        status: asStatus(t.status) ?? "pending",
        activeForm: t.activeForm ? String(t.activeForm) : undefined,
      }))
      .filter((t: Todo) => t.content);
  }
  if (name === "TaskCreate") {
    const content = String(input.subject ?? input.description ?? "").trim();
    if (!content) return null;
    return [...current, { content, status: "pending", activeForm: input.activeForm ? String(input.activeForm) : undefined }];
  }
  if (name === "TaskUpdate") {
    const i = Number(String(input.taskId ?? input.id ?? "").replace(/\D/g, "")) - 1;
    if (!(i >= 0 && i < current.length)) return null;
    if (input.status === "deleted") return current.filter((_, k) => k !== i);
    const next = current.slice();
    next[i] = {
      ...next[i],
      status: asStatus(input.status) ?? next[i].status,
      content: input.subject ? String(input.subject) : next[i].content,
      activeForm: input.activeForm ? String(input.activeForm) : next[i].activeForm,
    };
    return next;
  }
  return null;
}

type Ev = { type: string; text: string; at: string };

const parse = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Dernier plan connu d'un run, avec l'heure de début et de fin de chaque étape. */
export function planFromEvents(events: Ev[]): PlanItem[] {
  const times = new Map<string, { startedAt: number | null; endedAt: number | null }>();
  let plan: Todo[] = [];
  let prevAt: number | null = null;
  for (const e of events) {
    if (e.type !== "todos") continue;
    const todos = parse(e.text);
    if (!Array.isArray(todos)) continue;
    const at = Date.parse(e.at);
    for (const t of todos as Todo[]) {
      const k = t.content;
      const cur = times.get(k) ?? { startedAt: null, endedAt: null };
      if (t.status === "in_progress" && cur.startedAt === null) cur.startedAt = at;
      if (t.status === "completed" && cur.endedAt === null) {
        cur.endedAt = at;
        cur.startedAt ??= prevAt ?? at;
      }
      times.set(k, cur);
    }
    plan = todos;
    prevAt = at;
  }
  return plan.map((t) => ({ ...t, ...(times.get(t.content) ?? { startedAt: null, endedAt: null }) }));
}

/** État de chaque sous-agent lancé pendant le run (le dernier événement de chacun l'emporte). */
export function subagentsFromEvents(events: Ev[]): Subagent[] {
  const map = new Map<string, Subagent>();
  for (const e of events) {
    if (e.type !== "subagent") continue;
    const s = parse(e.text);
    if (s && typeof s.id === "string") map.set(s.id, { ...map.get(s.id), ...s });
  }
  return [...map.values()];
}

/** Motif de liste blanche qui couvre un appel d'outil : « Bash(npm run test*) » ou le nom de l'outil. */
export function allowPatternFor(tool: string, input: Record<string, unknown>) {
  if (tool !== "Bash") return tool;
  const words = String(input.command ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
  return words.length ? `Bash(${words.join(" ")}*)` : "Bash";
}
