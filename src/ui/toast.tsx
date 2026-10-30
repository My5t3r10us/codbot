import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Bot } from "./bot";
import { cn } from "./cn";

type Toast = { id: number; title: string; sub?: string; tone?: "default" | "err" };
const Ctx = createContext<(title: string, sub?: string, tone?: Toast["tone"]) => void>(() => {});

export function useToast() {
  return useContext(Ctx);
}

export function Toaster({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((title: string, sub?: string, tone: Toast["tone"] = "default") => {
    const id = next.current++;
    setList((l) => [...l.slice(-2), { id, title, sub, tone }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), tone === "err" ? 6000 : 3200);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed top-16 right-5 z-[60] flex w-[min(380px,calc(100vw-40px))] flex-col gap-2" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={cn("pop-in pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 shadow-[0_24px_48px_-12px_rgba(0,0,0,.25)]", t.tone === "err" && "border-err/40")}>
            <Bot size={20} brand={t.tone !== "err"} mood={t.tone === "err" ? "err" : "idle"} />
            <span className="flex min-w-0 flex-col leading-snug">
              <b className="text-[13.5px] font-semibold">{t.title}</b>
              {t.sub && <span className="truncate text-[12.5px] text-muted-foreground" title={t.sub}>{t.sub}</span>}
            </span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
