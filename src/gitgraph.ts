// Mise en couloirs d'un historique git (style « git log --graph ») : fonction pure, testée.

export type GraphInput = { sha: string; parents: string[] };
/** Segment d'un couloir à un autre : `from` → `to` (indices de couloir). */
export type Seg = { from: number; to: number; color: number };
export type GraphRow = {
  sha: string;
  lane: number;
  color: number;
  /** Du haut de la ligne au milieu (le point du commit). */
  up: Seg[];
  /** Du milieu au bas de la ligne. */
  down: Seg[];
  width: number;
};

export function layoutGraph(commits: GraphInput[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const free = () => {
    const i = lanes.indexOf(null);
    return i < 0 ? lanes.length : i;
  };
  const rows: GraphRow[] = [];

  for (const c of commits) {
    let idx = lanes.indexOf(c.sha);
    const existed = idx >= 0;
    if (!existed) {
      idx = free();
      lanes[idx] = c.sha;
      colors[idx] = nextColor++;
    }
    const before = lanes.slice();
    const up: Seg[] = [];
    before.forEach((sha, i) => {
      if (sha === null) return;
      if (sha === c.sha) {
        if (i !== idx || existed) up.push({ from: i, to: idx, color: colors[i] });
      } else up.push({ from: i, to: i, color: colors[i] });
    });
    const color = colors[idx];
    // Les autres couloirs qui attendaient ce commit se referment ici.
    lanes.forEach((sha, i) => {
      if (sha === c.sha && i !== idx) lanes[i] = null;
    });
    const fresh = new Set<number>();
    const extra: Seg[] = [];
    if (!c.parents.length) lanes[idx] = null;
    else {
      lanes[idx] = c.parents[0];
      for (const p of c.parents.slice(1)) {
        const j = lanes.indexOf(p);
        if (j >= 0) extra.push({ from: idx, to: j, color: colors[j] });
        else {
          const k = free();
          lanes[k] = p;
          colors[k] = nextColor++;
          fresh.add(k);
        }
      }
    }
    const down: Seg[] = [...extra];
    lanes.forEach((sha, i) => {
      if (sha === null) return;
      if (i === idx || fresh.has(i)) down.push({ from: idx, to: i, color: colors[i] });
      else if (before[i] !== null && before[i] !== c.sha) down.push({ from: i, to: i, color: colors[i] });
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ sha: c.sha, lane: idx, color, up, down, width: Math.max(before.length, lanes.length, idx + 1) });
  }
  return rows;
}
