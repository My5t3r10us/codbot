import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-1.5 text-[11.5px] font-medium",
  {
    variants: {
      tone: {
        outline: "border border-border text-muted-foreground",
        muted: "bg-muted text-muted-foreground",
        run: "bg-brand/12 text-brand-fg",
        wait: "bg-warn/15 text-warn-fg",
        err: "bg-err/12 text-err-fg",
        ok: "bg-ok/12 text-ok-fg",
        rev: "bg-rev/12 text-rev-fg",
      },
    },
    defaultVariants: { tone: "outline" },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants> & { dot?: boolean; pulse?: boolean };

export function Badge({ className, tone, dot, pulse, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span className={cn("ldot", pulse && "pulse")} />}
      {children}
    </span>
  );
}
