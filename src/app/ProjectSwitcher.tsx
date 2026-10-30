import { Check, ChevronsUpDown, LayoutGrid, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ACTIVE_STATES } from "../rules";
import { NEEDS_YOU } from "../labels";
import { cn } from "../ui/cn";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useNav } from "./nav";
import { useCurrentProject, useRuns } from "./store";

const PALETTE = ["#2563EB", "#16A34A", "#D97706", "#7C3AED", "#DB2777", "#0891B2", "#DC2626", "#4F46E5"];

/** Couleur stable d'un projet (dérivée de l'ID de la liste). */
export function projectColor(listId: string) {
  let h = 0;
  for (const c of listId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function ProjectMark({ name, listId, size = 22 }: { name: string; listId: string; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[6px] font-bold text-white"
      style={{ width: size, height: size, background: projectColor(listId), fontSize: size * 0.48, borderRadius: size * 0.28 }}
      aria-hidden
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function ProjectSwitcher() {
  const { projects, current, setCurrent } = useCurrentProject();
  const runs = useRuns();
  const nav = useNav();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const stats = useMemo(() => {
    const m = new Map<string, { active: number; needs: number }>();
    for (const r of runs.data) {
      const s = m.get(r.list_id) ?? { active: 0, needs: 0 };
      if (ACTIVE_STATES.includes(r.state)) s.active++;
      if (NEEDS_YOU.includes(r.state)) s.needs++;
      m.set(r.list_id, s);
    }
    return m;
  }, [runs.data]);

  const list = projects.filter((p) => !q || p.list_name.toLowerCase().includes(q.toLowerCase()));

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); setQ(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-[34px] max-w-[280px] cursor-pointer items-center gap-2 rounded-[9px] px-1.5 text-[13.5px] font-medium hover:bg-muted data-[state=open]:bg-muted"
        >
          {current ? <ProjectMark name={current.list_name} listId={current.list_id} /> : <span className="size-[22px] rounded-[6px] bg-muted" />}
          <span className="truncate">{current?.list_name ?? "Aucun projet"}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px]">
        <label className="-mx-1.5 -mt-1.5 mb-1 flex h-10 items-center gap-2 border-b border-border px-3 text-muted-foreground">
          <Search className="size-3.5" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Changer de projet…"
            aria-label="Rechercher un projet"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="px-2 pt-1.5 pb-1 text-[11.5px] font-semibold text-muted-foreground">Projets</div>
        {list.map((p) => {
          const s = stats.get(p.list_id);
          const meta = !p.repo_path ? "à configurer" : s?.needs ? `${s.needs} attend${s.needs > 1 ? "ent" : ""} toi` : s?.active ? `${s.active} agent${s.active > 1 ? "s" : ""}` : "";
          return (
            <button
              key={p.list_id}
              type="button"
              disabled={!p.repo_path}
              onClick={() => { void setCurrent(p.list_id); setOpen(false); }}
              className={cn(
                "flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13.5px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
                current?.list_id === p.list_id && "bg-brand/8",
              )}
            >
              <ProjectMark name={p.list_name} listId={p.list_id} />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate font-medium">{p.list_name}</span>
                <span className="truncate font-mono text-[11.5px] text-muted-foreground">{p.repo_path || "Repo local à renseigner sur ce PC"}</span>
              </span>
              {meta && <span className={cn("text-[12px] whitespace-nowrap", s?.needs ? "text-warn-fg" : s?.active ? "text-brand-fg" : "text-muted-foreground")}>{meta}</span>}
              {current?.list_id === p.list_id && <Check className="size-3.5 text-brand-fg" />}
            </button>
          );
        })}
        {!list.length && <p className="px-2 py-3 text-[13px] text-muted-foreground">Aucun projet.</p>}
        <div className="-mx-1.5 my-1.5 h-px bg-border" />
        <button type="button" onClick={() => { nav.go("projects"); setOpen(false); }} className="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-[13.5px] hover:bg-muted">
          <LayoutGrid className="size-4 text-muted-foreground" />Tous les projets
        </button>
        <button type="button" onClick={() => { nav.go("settings"); setOpen(false); }} className="flex min-h-10 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-[13.5px] hover:bg-muted">
          <Plus className="size-4 text-muted-foreground" />Ajouter un projet
        </button>
      </PopoverContent>
    </Popover>
  );
}
