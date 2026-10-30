import { describe, expect, it } from "vitest";
import { layoutGraph } from "../src/gitgraph";

describe("layoutGraph", () => {
  it("historique linéaire : un seul couloir", () => {
    const rows = layoutGraph([{ sha: "c", parents: ["b"] }, { sha: "b", parents: ["a"] }, { sha: "a", parents: [] }]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(Math.max(...rows.map((r) => r.width))).toBe(1);
  });

  it("une branche ouvre un second couloir qui se referme sur sa base", () => {
    // main: m2 → m1 → base ; branche: b1 → base
    const rows = layoutGraph([
      { sha: "m2", parents: ["m1"] },
      { sha: "b1", parents: ["base"] },
      { sha: "m1", parents: ["base"] },
      { sha: "base", parents: [] },
    ]);
    expect(rows[0].lane).toBe(0);
    expect(rows[1].lane).toBe(1);
    expect(rows[1].color).not.toBe(rows[0].color);
    expect(rows[3].lane).toBe(0);
    // Le couloir de la branche rejoint celui de la base.
    expect(rows[3].up.some((s) => s.from === 1 && s.to === 0)).toBe(true);
  });

  it("un merge relie le second parent", () => {
    const rows = layoutGraph([
      { sha: "merge", parents: ["m1", "b1"] },
      { sha: "b1", parents: ["base"] },
      { sha: "m1", parents: ["base"] },
      { sha: "base", parents: [] },
    ]);
    expect(rows[0].down.some((s) => s.from === 0 && s.to === 1)).toBe(true);
    expect(rows[1].lane).toBe(1);
  });
});
