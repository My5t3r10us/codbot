import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-[34px] w-full rounded-md border border-border bg-card px-2.5 text-[13.5px] shadow-xs outline-none transition-[border,box-shadow] placeholder:text-muted-foreground focus:border-border-strong focus:ring-3 focus:ring-faint/25 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-md border border-border bg-card px-2.5 py-2 text-[13.5px] shadow-xs outline-none transition-[border,box-shadow] placeholder:text-muted-foreground focus:border-border-strong focus:ring-3 focus:ring-faint/25",
        className,
      )}
      {...props}
    />
  );
});

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("flex flex-col gap-1.5 text-[12.5px] font-medium text-muted-foreground", className)} {...props} />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded-[4px] border border-border bg-muted px-1 font-mono text-[11px] text-foreground">{children}</kbd>;
}
