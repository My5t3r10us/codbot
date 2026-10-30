import { Popover as P } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;

export function PopoverContent({ className, align = "start", sideOffset = 6, ...props }: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={sideOffset}
        className={cn("pop-in z-50 rounded-xl border border-border bg-card p-1.5 shadow-[0_24px_48px_-12px_rgba(0,0,0,.25)] outline-none", className)}
        {...props}
      />
    </P.Portal>
  );
}
