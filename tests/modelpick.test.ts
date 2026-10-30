import { describe, expect, it } from "vitest";
import type { CuTask } from "../src/clickup";
import { DEFAULT_POLICY, clamp, classify, normalizePolicy, parseTriage, pickFor, tagOverride } from "../src/modelpick";

const task = (name: string, extra: Partial<CuTask> = {}): CuTask => ({
  id: name, custom_id: null, name, status: { status: "à faire", color: "", type: "open" }, assignees: [], tags: [], url: "",
  parent: null, list: { id: "l", name: "L" }, space: { id: "s" }, due_date: null, ...extra,
});

describe("classify", () => {
  it("reconnaît la catégorie par les mots-clés du nom", () => {
    expect(classify([task("Corriger le crash au démarrage")]).category).toBe("bug");
    expect(classify([task("Corriger une faute dans le README")]).category).toBe("docs");
    expect(classify([task("Refonte de l'architecture des runs")]).category).toBe("refactor");
    expect(classify([task("Ajouter un bouton d'export")]).category).toBe("feature");
  });

  it("estime la taille : longueur, sous-éléments, nombre de tâches", () => {
    expect(classify([task("Ajouter un bouton")]).size).toBe("small");
    const items = Array.from({ length: 9 }, (_, i) => ({ name: `étape ${i}`, resolved: false }));
    expect(classify([task("Ajouter un module", { checklists: [{ name: "c", items }], markdown_description: "x".repeat(3000) })]).size).toBe("large");
    expect(classify([task("a"), task("b")]).size).toBe("medium");
  });

  it("un tag de taille tranche", () => {
    expect(classify([task("Ajouter un bouton", { tags: [{ name: "taille:grande" }] })]).size).toBe("large");
  });
});

describe("clamp", () => {
  const allowed = { haiku: [], sonnet: ["medium", "high"], opus: [], fable: [] } as never;

  it("garde le modèle et prend l'effort autorisé le plus proche (vers le haut à égalité)", () => {
    expect(clamp({ model: "sonnet", effort: "low" }, allowed)).toEqual({ model: "sonnet", effort: "medium" });
    expect(clamp({ model: "sonnet", effort: "max" }, allowed)).toEqual({ model: "sonnet", effort: "high" });
  });

  it("remplace un modèle interdit par le plus proche en capacité", () => {
    expect(clamp({ model: "opus", effort: "high" }, allowed)).toEqual({ model: "sonnet", effort: "high" });
    const two = { haiku: ["low"], sonnet: [], opus: ["high"], fable: [] } as never;
    expect(clamp({ model: "sonnet", effort: "medium" }, two)?.model).toBe("opus");
  });

  it("rien d'autorisé : null", () => {
    expect(clamp({ model: "opus", effort: "high" }, { haiku: [], sonnet: [], opus: [], fable: [] })).toBeNull();
  });
});

describe("pickFor", () => {
  it("suit la matrice puis les autorisations", () => {
    const p = pickFor([task("Corriger le crash au démarrage")], DEFAULT_POLICY)!;
    expect(p).toMatchObject({ model: "sonnet", effort: "medium", category: "bug", size: "small" });
  });

  it("les tags forcent modèle et effort, bornés aux autorisations", () => {
    const t = task("Ajouter un bouton", { tags: [{ name: "modele:opus" }, { name: "effort:low" }] });
    expect(tagOverride([t])).toEqual({ model: "opus", effort: "low" });
    expect(pickFor([t], DEFAULT_POLICY)).toMatchObject({ model: "opus", effort: "medium" });
  });

  it("utilise le triage IA quand il est fourni", () => {
    const p = pickFor([task("x")], DEFAULT_POLICY, { category: "refactor", size: "large", why: "gros chantier" })!;
    expect(p).toMatchObject({ model: "fable", effort: "high" });
    expect(p.reason).toContain("gros chantier");
  });

  it("mode fixe et mode défaut", () => {
    expect(pickFor([task("x")], { ...DEFAULT_POLICY, mode: "fixed" })).toMatchObject({ model: "opus", effort: "high" });
    expect(pickFor([task("x")], { ...DEFAULT_POLICY, mode: "default" })).toBeNull();
  });
});

describe("normalizePolicy", () => {
  it("complète une politique vide avec les valeurs par défaut", () => {
    expect(normalizePolicy(null)).toEqual(DEFAULT_POLICY);
  });

  it("reprend l'ancien réglage « model » en mode fixe", () => {
    expect(normalizePolicy(null, "Sonnet")).toMatchObject({ mode: "fixed", fixed: { model: "sonnet" } });
  });

  it("écarte les valeurs inconnues", () => {
    const p = normalizePolicy({ mode: "x", allowed: { opus: ["high", "bogus"] }, matrix: { bug: { small: { model: "gpt", effort: "low" } } } });
    expect(p.mode).toBe("auto");
    expect(p.allowed.opus).toEqual(["high"]);
    expect(p.matrix.bug.small).toEqual({ model: DEFAULT_POLICY.matrix.bug.small.model, effort: "low" });
  });
});

describe("parseTriage", () => {
  it("extrait le JSON même entouré de texte", () => {
    expect(parseTriage('Voici : {"category":"bug","size":"medium","why":"crash"} fin')).toEqual({ category: "bug", size: "medium", why: "crash" });
  });
  it("refuse une réponse invalide", () => {
    expect(parseTriage("{\"category\":\"autre\",\"size\":\"medium\"}")).toBeNull();
    expect(parseTriage("rien")).toBeNull();
  });
});
