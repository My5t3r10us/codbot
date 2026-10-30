/** Anneau de progression (0 → 1). */
export function Ring({ value, size = 30, stroke = 3, color = "var(--brand)", track = "var(--muted)", children, title }: {
  value: number; size?: number; stroke?: number; color?: string; track?: string; children?: React.ReactNode; title?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className="relative inline-grid shrink-0 place-items-center font-mono text-[9.5px] font-semibold" style={{ width: size, height: size }} title={title}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" style={{ stroke: track }} strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" style={{ stroke: color, transition: "stroke-dashoffset .9s cubic-bezier(.2,.8,.2,1)" }}
          strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v)}
        />
      </svg>
      {children}
    </span>
  );
}
