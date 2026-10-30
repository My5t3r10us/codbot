import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export const Dialog = D.Root;
export const DialogTitle = D.Title;
export const DialogDescription = D.Description;
export const DialogClose = D.Close;

function Overlay() {
  return <D.Overlay className="anim-fade fixed inset-0 z-40 bg-black/30" />;
}

export function DialogContent({ className, children, ...props }: ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <Overlay />
      <D.Content
        className={cn(
          "pop-in fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-40px)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_48px_-12px_rgba(0,0,0,.3)] outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </D.Content>
    </D.Portal>
  );
}

/** Panneau latéral (shadcn « Sheet ») bâti sur Dialog. */
export function SheetContent({ className, children, ...props }: ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <Overlay />
      <D.Content
        className={cn(
          "anim-sheet fixed top-0 right-0 bottom-0 z-50 flex w-[min(620px,100vw)] flex-col border-l border-border bg-card shadow-[0_24px_48px_-12px_rgba(0,0,0,.3)] outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </D.Content>
    </D.Portal>
  );
}

export function CloseButton({ label = "Fermer" }: { label?: string }) {
  return (
    <D.Close aria-label={label} className="grid size-[34px] cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
      <X className="size-4" />
    </D.Close>
  );
}

export function DialogHeader({ title, description, extra }: { title: ReactNode; description?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-5 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <D.Title className="text-[16px] font-semibold">{title}</D.Title>
        {description ? <D.Description className="text-[13px] text-muted-foreground">{description}</D.Description> : <D.Description className="sr-only">{String(title)}</D.Description>}
      </div>
      {extra}
      <CloseButton />
    </div>
  );
}
