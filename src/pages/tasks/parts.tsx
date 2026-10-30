// Petites briques des vues de tâches : priorité, échéance, assignés, verrou, bande d'agent.
import { ask } from "@tauri-apps/plugin-dialog";
import { CalendarClock, Lock } from "lucide-react";
import type * as cu from "../../clickup";
import type * as db from "../../db";
import * as lock from "../../lock";
import { activityText, planProgress } from "../../app/format";
import type { RunLive } from "../../app/store";
import { moodOf, STATE_LABEL, STATE_TONE, TONE_COLOR } from "../../labels";
import { dueInfo, initials, priorityLevel, PRIORITY_LABEL } from "../../taskview";
import { Bot } from "../../ui/bot";
import { cn } from "../../ui/cn";

export function PriorityBars({ task }: { task: cu.CuTask }) {
  const level = priorityLevel(task);
  const color = level === 4 ? "var(--err)" : level === 3 ? "var(--warn)" : "var(--foreground)";
  return (
    <span className="inline-flex h-3 items-end gap-[2px]" title={`Priorité ${PRIORITY_LABEL[level]}`} aria-label={`Priorité ${PRIORITY_LABEL[level]}`}>
      {[1, 2, 3].map((i) => (
        <i key={i} className="block w-[3px] rounded-[1px]" style={{ height: 4 + i * 2.5, background: level > 0 && i <= Math.min(level, 3) ? color : "var(--border)" }} />
      ))}
    </span>
  );
}

export function Due({ due }: { due: string | null }) {
  const d = dueInfo(due);
  if (!d.label) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[12px]", d.tone === "err" ? "text-err-fg" : d.tone === "warn" ? "text-warn-fg" : "text-muted-foreground")}>
      <CalendarClock className="size-3" />
      {d.label}
    </span>
  );
}

export function Assignees({ users, max = 3 }: { users: cu.CuUser[]; max?: number }) {
  if (!users.length) return null;
  return (
    <span className="flex -space-x-1.5" title={users.map((u) => u.username).join(", ")}>
      {users.slice(0, max).map((u) => (
        <span key={u.id} className="grid size-[22px] place-items-center rounded-full border-2 border-card text-[9.5px] font-semibold text-white" style={{ background: u.color || "#71717a" }}>
          {initials(u)}
        </span>
      ))}
      {users.length > max && <span className="grid size-[22px] place-items-center rounded-full border-2 border-card bg-muted text-[9.5px] font-semibold text-muted-foreground">+{users.length - max}</span>}
    </span>
  );
}

/** Verrou posé par un autre PC, avec « Libérer » (si ce PC ne travaille plus dessus). */
export function LockBadge({ task, tag, onReleased }: { task: cu.CuTask; tag: string; onReleased(): void }) {
  const pc = tag.slice(lock.LOCK_PREFIX.length);
  async function release(e: React.MouseEvent) {
    e.stopPropagation();
    const yes = await ask(`Libérer « ${task.name} » ? À faire seulement si ${pc} ne travaille plus dessus (PC éteint, app plantée).`, { title: "Codbot", kind: "warning" });
    if (!yes) return;
    await lock.release(task.id, tag);
    onReleased();
  }
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-warn/12 pr-1 pl-1.5 text-[12px] text-warn-fg">
      <Lock className="size-3" />
      Pris par {pc}
      <button type="button" onClick={release} className="cursor-pointer rounded px-1 font-medium underline-offset-2 hover:underline">Libérer</button>
    </span>
  );
}

/** Bande « agent au travail » sous une tâche : état, ce qu'il fait, avancement du plan. */
export function AgentStrip({ run, live, onOpen, compact }: { run: db.Run; live?: RunLive; onOpen(): void; compact?: boolean }) {
  const tone = STATE_TONE[run.state];
  const working = tone === "run";
  const text = activityText(run, live?.ev);
  const progress = planProgress(live?.plan);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      className={cn(
        "group/strip relative flex w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg border px-2 text-left transition-colors",
        compact ? "h-7" : "h-8",
        tone === "wait" ? "border-warn/35 bg-warn/8 hover:bg-warn/12" : tone === "err" ? "border-err/30 bg-err/6 hover:bg-err/10" : "border-border bg-muted/50 hover:bg-muted",
      )}
      title={`${STATE_LABEL[run.state]} · ouvrir la session`}
    >
      <Bot mood={moodOf(run.state)} size={compact ? 16 : 18} brand={working} />
      <span className={cn("min-w-0 flex-1 truncate text-[12px]", working ? "shimmer-text" : tone === "wait" ? "font-medium text-warn-fg" : tone === "err" ? "text-err-fg" : "text-muted-foreground")}>
        {text}
      </span>
      {progress !== null && <span className="font-mono text-[11px] text-muted-foreground">{Math.round(progress * 100)} %</span>}
      {progress !== null && (
        <span className="absolute right-0 bottom-0 left-0 h-[2px] bg-transparent">
          <span className="block h-full transition-[width] duration-700" style={{ width: `${progress * 100}%`, background: TONE_COLOR[tone] }} />
        </span>
      )}
    </button>
  );
}
