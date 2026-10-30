import { ListPlus, Play, X } from "lucide-react";
import { useState } from "react";
import type * as cu from "../../clickup";
import type * as db from "../../db";
import { activityText, planProgress } from "../../app/format";
import type { RunLive } from "../../app/store";
import { moodOf, STATE_TONE, TONE_COLOR } from "../../labels";
import { Bot } from "../../ui/bot";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Ring } from "../../ui/ring";

/**
 * Dock des agents en bas de la page Tâches : un emplacement par agent possible (réglage
 * « concurrency »). On y dépose des tâches pour les confier à un agent.
 */
export function AgentDock({
  slots, active, live, queued, selection, dragging, onDrop, onLaunch, onClear, onOpenRun,
}: {
  slots: number; active: db.Run[]; live: Map<string, RunLive>; queued: number; selection: cu.CuTask[]; dragging: boolean;
  onDrop(ids: string[]): void; onLaunch(): void; onClear(): void; onOpenRun(id: string): void;
}) {
  const [over, setOver] = useState(false);
  const free = Math.max(0, slots - active.length);
  const cells = Math.max(slots, active.length);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setOver(true); }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const ids = e.dataTransfer.getData("text/plain").split(",").filter(Boolean);
        if (ids.length) onDrop(ids);
      }}
      className={cn(
        "relative mx-4 mb-4 flex items-center gap-3 rounded-2xl border bg-card/95 p-2.5 shadow-[0_12px_32px_-12px_rgba(0,0,0,.18)] backdrop-blur transition-[border-color,box-shadow,transform]",
        dragging ? "border-brand/50 border-dashed" : "border-border",
        over && "scale-[1.01] border-brand shadow-[0_0_0_4px_color-mix(in_oklab,var(--brand)_18%,transparent)]",
      )}
      aria-label="Dock des agents : dépose des tâches ici pour les confier à un agent"
    >
      <div className="flex shrink-0 items-center gap-2.5 pl-1.5">
        <Bot brand mood={active.length ? "run" : "idle"} size={26} />
        <div className="leading-tight">
          <div className="text-[13px] font-semibold">Agents</div>
          <div className="text-[11.5px] text-muted-foreground">{active.length}/{slots} au travail{queued ? ` · ${queued} en file` : ""}</div>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
        {Array.from({ length: cells }, (_, i) => {
          const run = active[i];
          if (!run) {
            return (
              <div key={`free-${i}`} className={cn("flex h-12 min-w-[180px] flex-1 items-center justify-center gap-2 rounded-xl border border-dashed text-[12.5px] text-muted-foreground transition-colors", over ? "border-brand bg-brand/6 text-brand-fg" : "border-border-strong")}>
                <Bot size={16} mood="sleep" />
                {over ? "Lâche pour lancer" : "Libre · glisse une tâche"}
              </div>
            );
          }
          const tone = STATE_TONE[run.state];
          const progress = planProgress(live.get(run.id)?.plan);
          return (
            <button
              key={run.id}
              type="button"
              onClick={() => onOpenRun(run.id)}
              className="fade-up flex h-12 min-w-[220px] flex-1 cursor-pointer items-center gap-2.5 rounded-xl border border-border bg-background px-2.5 text-left hover:border-border-strong"
            >
              <Ring value={progress ?? 0} size={30} color={TONE_COLOR[tone]}>
                <Bot size={14} mood={moodOf(run.state)} />
              </Ring>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[12.5px] font-medium">{run.task_names.join(", ")}</span>
                <span className={cn("block truncate text-[11.5px]", tone === "run" ? "shimmer-text" : tone === "wait" ? "text-warn-fg" : tone === "err" ? "text-err-fg" : "text-muted-foreground")}>
                  {activityText(run, live.get(run.id)?.ev)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {selection.length > 0 ? (
        <div className="pop-in flex shrink-0 items-center gap-2 border-l border-border pl-3">
          <span className="text-[12.5px] text-muted-foreground"><b className="font-semibold text-foreground">{selection.length}</b> sélectionnée{selection.length > 1 ? "s" : ""}</span>
          <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Vider la sélection"><X /></Button>
          <Button variant="brand" onClick={onLaunch}>
            {free ? <Play /> : <ListPlus />}
            Confier à un agent
          </Button>
        </div>
      ) : (
        <span className="hidden shrink-0 pr-2 text-[12px] text-muted-foreground xl:block">Sélectionne ou glisse des tâches</span>
      )}
    </div>
  );
}
