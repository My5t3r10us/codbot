import { Bot as BotIcon, Kanban, LayoutGrid, Settings } from "lucide-react";
import { ACTIVE_STATES } from "../rules";
import { Bot } from "../ui/bot";
import { cn } from "../ui/cn";
import { Ring } from "../ui/ring";
import { useNav, type Page } from "./nav";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { useRuns, useUsage } from "./store";

function Tab({ page, icon, label, extra }: { page: Page; icon: React.ReactNode; label: string; extra?: React.ReactNode }) {
  const nav = useNav();
  const on = nav.page === page;
  return (
    <button
      type="button"
      aria-current={on ? "page" : undefined}
      onClick={() => nav.go(page)}
      className={cn(
        "inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[7px] px-3 text-[13.5px] font-medium text-muted-foreground transition-[background,color,box-shadow] hover:text-foreground [&_svg]:size-[15px]",
        on && "bg-card text-foreground shadow-xs",
      )}
    >
      {icon}
      {label}
      {extra}
    </button>
  );
}

export function TopBar({ settingsAlert }: { settingsAlert: string | null }) {
  const nav = useNav();
  const runs = useRuns();
  const usage = useUsage();
  const active = runs.data.filter((r) => ACTIVE_STATES.includes(r.state)).length;
  const five = usage.data?.windows.find((w) => w.name === "5 h") ?? usage.data?.windows[0];
  const blockedWindow = usage.data?.windows.some((w) => w.status && w.status !== "allowed");
  const time = (ms: number | null) => (ms ? new Date(ms).toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "?");

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="mark bot" style={{ ["--s" as string]: "26px" }} aria-hidden><i /><i /></span>
        <b className="text-[15px] font-semibold">Codbot</b>
        <span className="text-faint">/</span>
        <ProjectSwitcher />
      </div>
      <nav aria-label="Pages" className="inline-flex rounded-[10px] bg-muted p-[3px]">
        <Tab page="projects" icon={<LayoutGrid />} label="Projets" />
        <Tab page="tasks" icon={<Kanban />} label="Tâches" />
        <Tab
          page="agents"
          icon={<BotIcon />}
          label="Agents"
          extra={active ? <span className="inline-flex h-[18px] items-center gap-1 rounded-full bg-brand/12 px-1.5 text-[11px] font-semibold text-brand-fg"><span className="ldot pulse" />{active}</span> : null}
        />
      </nav>
      <div className="flex-1" />
      {five && (
        <span
          className={cn("inline-flex items-center gap-1.5 text-[13px] text-muted-foreground", blockedWindow ? "text-err-fg" : five.utilization >= 0.8 && "text-warn-fg")}
          title={[...(usage.data?.windows ?? []).map((w) => `${w.name} : ${Math.round(w.utilization * 100)} %, réinitialisation ${time(w.resetsAt)}`), `Mis à jour ${new Date(usage.data!.at).toLocaleTimeString("fr-FR")}`].join("\n")}
        >
          <Ring value={five.utilization} size={18} stroke={3} color={blockedWindow ? "var(--err)" : five.utilization >= 0.8 ? "var(--warn)" : "var(--foreground)"} />
          {Math.round(five.utilization * 100)} %
        </span>
      )}
      <button
        type="button"
        aria-label="Réglages"
        title={settingsAlert ?? "Réglages"}
        onClick={() => nav.go("settings")}
        className={cn("relative grid size-[34px] cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground", nav.page === "settings" && "bg-muted text-foreground")}
      >
        <Settings className="size-[18px]" />
        {settingsAlert && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-warn ring-2 ring-card" />}
      </button>
      <Bot size={26} brand mood={active ? "run" : "idle"} title={active ? `${active} agent(s) au travail` : "Aucun agent au travail"} />
    </header>
  );
}
