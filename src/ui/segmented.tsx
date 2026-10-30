import type { ReactNode } from "react";
import { cn } from "./cn";

export type SegOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean; title?: string };

/** Groupe de boutons exclusifs (shadcn « ToggleGroup » / Tabs). */
export function Segmented<T extends string>({
  value, onChange, options, className, label, size = "default",
}: { value: T; onChange: (v: T) => void; options: SegOption<T>[]; className?: string; label?: string; size?: "default" | "lg" }) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex rounded-[9px] bg-muted p-[3px]", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          title={o.title}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[6px] px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-[background,color,box-shadow] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-3.5",
            size === "lg" ? "h-9" : "h-7",
            value === o.value && "bg-card text-foreground shadow-xs",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
