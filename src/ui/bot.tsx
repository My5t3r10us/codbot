import { cn } from "./cn";

export type Mood = "run" | "wait" | "err" | "sleep" | "idle";

/** Petit visage d'agent : les yeux bougent quand il travaille, sautillent quand il attend. */
export function Bot({ mood = "idle", size = 26, brand, className, title }: { mood?: Mood; size?: number; brand?: boolean; className?: string; title?: string }) {
  return (
    <span
      className={cn("bot", mood !== "idle" && mood, brand && "brand", className)}
      style={{ ["--s" as string]: `${size}px` }}
      title={title}
      aria-hidden={title ? undefined : true}
    >
      <i />
      <i />
    </span>
  );
}
