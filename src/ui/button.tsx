import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13.5px] font-medium transition-[background,opacity,box-shadow,transform] active:scale-[.97] disabled:pointer-events-none disabled:opacity-45 cursor-pointer select-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        brand: "bg-brand text-white hover:brightness-95",
        outline: "border border-border bg-card shadow-xs hover:bg-muted",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        destructive: "text-err-fg hover:bg-err/10",
        warn: "bg-warn text-white hover:brightness-95",
      },
      size: {
        default: "h-[34px] px-3",
        sm: "h-7 px-2.5 text-[12.5px] rounded-[7px] [&_svg]:size-3.5",
        icon: "size-[34px]",
        "icon-sm": "size-7 rounded-[7px] [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
