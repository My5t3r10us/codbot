// Choix du modèle Claude et de l'effort de raisonnement pour un run : classement de la tâche
// (catégorie × taille), matrice de recommandation, puis bornage aux modèles et efforts autorisés.
import type { CuTask } from "./clickup";

export const MODELS = [
  { id: "haiku", label: "Haiku", hint: "Rapide et économe" },
  { id: "sonnet", label: "Sonnet", hint: "Polyvalent" },
  { id: "opus", label: "Opus", hint: "Raisonnement poussé" },
  { id: "fable", label: "Fable", hint: "Le plus capable" },
] as const;
export type ModelId = (typeof MODELS)[number]["id"];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const EFFORT_LABELS: Record<Effort, string> = { low: "Bas", medium: "Moyen", high: "Élevé", xhigh: "Très élevé", max: "Max" };

export const CATEGORIES = [
  { id: "docs", label: "Docs et textes", hint: "Typo, libellé, README, traduction" },
  { id: "bug", label: "Correction de bug", hint: "Erreur, crash, régression" },
  { id: "feature", label: "Fonctionnalité", hint: "Ajout ou évolution (par défaut)" },
  { id: "refactor", label: "Refonte, architecture", hint: "Refacto, migration, sécurité, perf" },
  { id: "investigation", label: "Analyse", hint: "Enquête, audit, étude sans livrable de code" },
] as const;
export type Category = (typeof CATEGORIES)[number]["id"];

export const SIZES = [
  { id: "small", label: "Petite" },
  { id: "medium", label: "Moyenne" },
  { id: "large", label: "Grande" },
] as const;
export type Size = (typeof SIZES)[number]["id"];

export type Choice = { model: ModelId; effort: Effort };
export type Matrix = Record<Category, Record<Size, Choice>>;

export type ModelPolicy = {
  /** auto : matrice ; fixed : `fixed` pour tous les runs ; default : rien de passé à Claude Code. */
  mode: "auto" | "fixed" | "default";
  fixed: Choice;
  /** Efforts autorisés par modèle ; un modèle sans effort autorisé n'est jamais choisi. */
  allowed: Record<ModelId, Effort[]>;
  matrix: Matrix;
  /** rules : heuristiques locales ; ai : un appel court à Haiku classe la tâche (repli sur les règles). */
  triage: "rules" | "ai";
};

export type Pick = Choice & { category: Category; size: Size; reason: string };

const c = (model: ModelId, effort: Effort): Choice => ({ model, effort });

export const DEFAULT_MATRIX: Matrix = {
  docs: { small: c("haiku", "low"), medium: c("haiku", "medium"), large: c("sonnet", "medium") },
  bug: { small: c("sonnet", "medium"), medium: c("sonnet", "high"), large: c("opus", "high") },
  feature: { small: c("sonnet", "medium"), medium: c("opus", "medium"), large: c("opus", "high") },
  refactor: { small: c("sonnet", "high"), medium: c("opus", "high"), large: c("fable", "high") },
  investigation: { small: c("sonnet", "high"), medium: c("opus", "high"), large: c("opus", "xhigh") },
};

export const DEFAULT_POLICY: ModelPolicy = {
  mode: "auto",
  fixed: c("opus", "high"),
  allowed: { haiku: ["low", "medium"], sonnet: ["low", "medium", "high"], opus: ["medium", "high", "xhigh"], fable: ["high"] },
  matrix: DEFAULT_MATRIX,
  triage: "rules",
};

const isModel = (v: unknown): v is ModelId => MODELS.some((m) => m.id === v);
const isEffort = (v: unknown): v is Effort => EFFORTS.includes(v as Effort);
export const isCategory = (v: unknown): v is Category => CATEGORIES.some((x) => x.id === v);
export const isSize = (v: unknown): v is Size => SIZES.some((x) => x.id === v);
const rank = (m: ModelId) => MODELS.findIndex((x) => x.id === m);
export const modelLabel = (m: string) => MODELS.find((x) => x.id === m)?.label ?? m;
export const choiceLabel = (ch: Choice) => `${modelLabel(ch.model)} · ${EFFORT_LABELS[ch.effort]}`;

/** Politique lue en base, complétée et nettoyée. `legacyModel` : ancien réglage « model » (texte libre). */
export function normalizePolicy(raw: unknown, legacyModel = ""): ModelPolicy {
  const p = (raw && typeof raw === "object" ? raw : {}) as Partial<ModelPolicy>;
  const choice = (v: unknown, fb: Choice): Choice => {
    const o = (v ?? {}) as Partial<Choice>;
    return { model: isModel(o.model) ? o.model : fb.model, effort: isEffort(o.effort) ? o.effort : fb.effort };
  };
  const allowed = {} as Record<ModelId, Effort[]>;
  for (const m of MODELS) {
    const list = p.allowed?.[m.id];
    allowed[m.id] = Array.isArray(list) ? EFFORTS.filter((e) => list.includes(e)) : [...DEFAULT_POLICY.allowed[m.id]];
  }
  const matrix = {} as Matrix;
  for (const cat of CATEGORIES) {
    matrix[cat.id] = {} as Record<Size, Choice>;
    for (const s of SIZES) matrix[cat.id][s.id] = choice(p.matrix?.[cat.id]?.[s.id], DEFAULT_MATRIX[cat.id][s.id]);
  }
  const legacy = legacyModel.trim().toLowerCase();
  const mode = p.mode === "auto" || p.mode === "fixed" || p.mode === "default" ? p.mode : isModel(legacy) ? "fixed" : DEFAULT_POLICY.mode;
  const fixedFallback = isModel(legacy) ? c(legacy, DEFAULT_POLICY.fixed.effort) : DEFAULT_POLICY.fixed;
  return { mode, fixed: choice(p.fixed, fixedFallback), allowed, matrix, triage: p.triage === "ai" ? "ai" : "rules" };
}

// ---------- classement de la tâche ----------

// À score égal, la première l'emporte : de la catégorie la plus spécifique à la plus générale.
const KEYWORDS: [Category, RegExp][] = [
  ["investigation", /\b(analys|investig|audit|enqu[eê]t|[ée]tudi|diagnostiqu|comprendre|pourquoi|benchmark|explor|recherch)/i],
  ["refactor", /\b(refacto|refont|architect|migr|r[ée][ée]cri|restructur|d[ée]coupl|s[ée]curit|perf|optimis|mont[ée]e de version|upgrade)/i],
  ["docs", /\b(doc|readme|typo|faute|orthograph|libell[ée]|wording|traduc|translat|texte|changelog|commentaire)/i],
  ["bug", /\b(bug|fix|corrig|correct|erreur|error|crash|plant|r[ée]gression|ne (marche|fonctionne) (plus|pas)|cass[ée]|exception|500\b)/i],
];

/** Texte utile d'une tâche pour le classement. */
const textOf = (t: CuTask) => [t.name, t.markdown_description ?? t.text_content ?? t.description ?? ""].join("\n");

export function classify(tasks: CuTask[]): { category: Category; size: Size; signals: string[] } {
  const signals: string[] = [];
  const tags = tasks.flatMap((t) => t.tags.map((x) => x.name.toLowerCase()));
  // Les noms comptent double : la description cite souvent d'autres sujets.
  const names = tasks.map((t) => t.name).join("\n");
  const body = tasks.map(textOf).join("\n");
  const scores = new Map<Category, number>();
  for (const [cat, re] of KEYWORDS) {
    const s = (re.test(names) ? 2 : 0) + (re.test(body) ? 1 : 0) + (tags.some((tag) => re.test(tag)) ? 3 : 0);
    if (s) scores.set(cat, s);
  }
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
  const category: Category = top?.[0] ?? "feature";
  signals.push(top ? `mots-clés « ${CATEGORIES.find((x) => x.id === category)!.label.toLowerCase()} »` : "aucun mot-clé : fonctionnalité");

  let points = 0;
  const chars = tasks.reduce((n, t) => n + textOf(t).length, 0);
  if (chars > 2500) points += 2;
  else if (chars > 700) points += 1;
  const items = tasks.reduce((n, t) => n + (t.checklists ?? []).reduce((k, l) => k + l.items.filter((i) => !i.resolved).length, 0) + (t.subtasks?.length ?? 0), 0);
  if (items >= 8) points += 2;
  else if (items >= 3) points += 1;
  if (tasks.length >= 4) points += 2;
  else if (tasks.length >= 2) points += 1;
  let size: Size = points >= 3 ? "large" : points >= 1 ? "medium" : "small";
  signals.push(`${chars} caractères, ${items} sous-éléments, ${tasks.length} tâche${tasks.length > 1 ? "s" : ""}`);
  // Un tag explicite tranche : « taille:grande », « size:small »…
  for (const tag of tags) {
    const m = /^(taille|size)\s*[:=]\s*(\w+)/.exec(tag);
    const v = m && ({ petite: "small", small: "small", moyenne: "medium", medium: "medium", grande: "large", large: "large" } as Record<string, Size>)[m[2]];
    if (v) { size = v; signals.push(`tag ${tag}`); }
  }
  return { category, size, signals };
}

/** Choix forcé par un tag ClickUp : « modele:opus », « model:sonnet », « effort:high ». */
export function tagOverride(tasks: CuTask[]): Partial<Choice> {
  const out: Partial<Choice> = {};
  for (const tag of tasks.flatMap((t) => t.tags.map((x) => x.name.toLowerCase().replace(/\s/g, "")))) {
    const [k, v] = tag.split(/[:=]/);
    if ((k === "modele" || k === "modèle" || k === "model") && isModel(v)) out.model = v;
    if (k === "effort" && isEffort(v)) out.effort = v;
  }
  return out;
}

// ---------- bornage aux autorisations ----------

/**
 * Ramène un choix dans ce qui est autorisé : même modèle si possible (effort le plus proche),
 * sinon le modèle autorisé le plus proche en capacité, de préférence au-dessus. Null si rien n'est autorisé.
 */
export function clamp(want: Choice, allowed: Record<ModelId, Effort[]>): Choice | null {
  const usable = MODELS.map((m) => m.id).filter((m) => allowed[m]?.length);
  if (!usable.length) return null;
  const r = rank(want.model);
  const model = usable.includes(want.model)
    ? want.model
    : [...usable].sort((a, b) => {
        const da = rank(a) - r, db = rank(b) - r;
        return Math.abs(da) - Math.abs(db) || db - da;
      })[0];
  const e = EFFORTS.indexOf(want.effort);
  const effort = [...allowed[model]].sort((a, b) => {
    const da = EFFORTS.indexOf(a) - e, db = EFFORTS.indexOf(b) - e;
    return Math.abs(da) - Math.abs(db) || db - da;
  })[0];
  return { model, effort };
}

/** Choix final pour un lot de tâches ; null en mode « default » (Claude Code décide). */
export function pickFor(tasks: CuTask[], policy: ModelPolicy, triaged?: { category: Category; size: Size; why?: string }): Pick | null {
  if (policy.mode === "default") return null;
  const auto = classify(tasks);
  const cls = triaged ?? auto;
  const base = policy.mode === "fixed" ? policy.fixed : policy.matrix[cls.category][cls.size];
  const forced = tagOverride(tasks);
  const want = { ...base, ...forced };
  const got = clamp(want, policy.allowed);
  if (!got) return null;
  const why: string[] = [];
  if (policy.mode === "fixed") why.push("modèle fixe des réglages");
  else {
    why.push(`${CATEGORIES.find((x) => x.id === cls.category)!.label}, taille ${SIZES.find((x) => x.id === cls.size)!.label.toLowerCase()}`);
    if (triaged?.why) why.push(`triage IA : ${triaged.why}`);
    else why.push(auto.signals.join(", "));
  }
  if (forced.model || forced.effort) why.push("forcé par tag ClickUp");
  if (got.model !== want.model || got.effort !== want.effort) why.push(`${choiceLabel(want)} non autorisé, ramené au plus proche`);
  return { ...got, category: cls.category, size: cls.size, reason: why.join(" ; ") };
}

// ---------- triage par IA ----------

/** Consigne envoyée au modèle de triage : la matrice lui sert de grille de lecture. */
export function triagePrompt(tasks: CuTask[]): string {
  const cats = CATEGORIES.map((x) => `- ${x.id} : ${x.label} (${x.hint})`).join("\n");
  const work = tasks.map((t) => `## ${t.name}\n${textOf(t).slice(t.name.length + 1, 4000)}\nTags : ${t.tags.map((x) => x.name).join(", ") || "aucun"}`).join("\n\n");
  return [
    "Tu classes une tâche de développement pour choisir le modèle d'IA qui la traitera. Ne fais rien d'autre.",
    "Catégories :", cats,
    "Tailles : small (quelques lignes, un fichier), medium (plusieurs fichiers, logique à concevoir), large (plusieurs modules, conception, risques).",
    "Réponds UNIQUEMENT par un objet JSON sur une ligne : {\"category\":\"…\",\"size\":\"…\",\"why\":\"raison en 12 mots max\"}",
    "", "Tâche(s) :", work,
  ].join("\n");
}

/** Lit la réponse du triage ; null si elle est inexploitable. */
export function parseTriage(text: string): { category: Category; size: Size; why: string } | null {
  const m = /\{[^{}]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (!isCategory(o.category) || !isSize(o.size)) return null;
    return { category: o.category, size: o.size, why: String(o.why ?? "").slice(0, 120) };
  } catch {
    return null;
  }
}
