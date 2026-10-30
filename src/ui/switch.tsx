import { Switch as S } from "radix-ui";
import { cn } from "./cn";

export function Switch({ checked, onCheckedChange, label, className }: { checked: boolean; onCheckedChange: (v: boolean) => void; label?: string; className?: string }) {
  return (
    <S.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className={cn("relative h-5 w-9 shrink-0 cursor-pointer rounded-full bg-border-strong transition-colors data-[state=checked]:bg-primary", className)}
    >
      <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform duration-300 data-[state=checked]:translate-x-[18px] dark:data-[state=checked]:bg-zinc-900" />
    </S.Root>
  );
}
