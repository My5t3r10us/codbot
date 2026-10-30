/** Chiffres qui roulent comme un compteur mécanique. */
export function Ticker({ value }: { value: number }) {
  const digits = String(Math.max(0, Math.round(value))).split("");
  return (
    <span className="inline-flex" aria-label={String(value)}>
      {digits.map((d, i) => (
        <span key={digits.length - i} className="inline-block h-[1em] overflow-hidden leading-none" aria-hidden>
          <span className="flex flex-col transition-transform duration-700 ease-[cubic-bezier(.2,.9,.3,1.1)]" style={{ transform: `translateY(-${Number(d) * 10}%)` }}>
            {"0123456789".split("").map((n) => (
              <span key={n} className="h-[1em] leading-none">{n}</span>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}
