// Briques partagées des vues d'agents : icône d'outil, titre de run, chrono, état.
import { Bot as BotIcon, FileText, Globe, ListTodo, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import type * as db from "../../db";
import { ago, mmss } from "../../app/format";
import { ACTIVE_STATES } from "../../rules";
import { useNow } from "../../app/store";
import { STATE_LABEL, STATE_TONE } from "../../labels";
import { Badge } from "../../ui/badge";

export function ToolIcon({ name, className = "size-3.5" }: { name: string; className?: string }) {
  const n = name.toLowerCase();
  const Icon = n === "read" ? FileText
    : n === "edit" || n === "write" || n === "multiedit" || n === "notebookedit" ? Pencil
    : n === "bash" ? SquareTerminal
    : n === "grep" || n === "glob" ? Search
    : n.startsWith("web") ? Globe
    : n === "task" || n === "agent" ? BotIcon
    : n.startsWith("todo") || n.startsWith("task") ? ListTodo
    : Wrench;
  return <Icon className={className} aria-hidden />;
}

export function StateBadge({ state }: { state: db.RunState }) {
  const tone = STATE_TONE[state];
  return <Badge tone={tone === "muted" ? "muted" : tone} dot pulse={tone === "run" || tone === "wait"}>{STATE_LABEL[state]}</Badge>;
}

/** Durée du run, qui avance chaque seconde tant qu'il n'est pas terminé. */
export function Elapsed({ run }: { run: db.Run }) {
  const now = useNow();
  // En revue, en pause, bloqué… : le chrono n'a plus de sens, on dit depuis quand le run existe.
  if (!run.ended_at && !ACTIVE_STATES.includes(run.state)) return <span>lancé {ago(run.created_at, now)}</span>;
  const end = run.ended_at ? Date.parse(run.ended_at) : now;
  return <span className="font-mono tabular-nums">{mmss(end - Date.parse(run.created_at))}</span>;
}

export const taskUrl = (id: string) => `https://app.clickup.com/t/${id}`;
