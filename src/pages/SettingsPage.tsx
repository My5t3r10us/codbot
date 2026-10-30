// Réglages : diagnostic, ClickUp, ce PC, agent, file d'attente, projets, partage, mises à jour.
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { CircleAlert, CircleCheck, Download, FolderOpen, Plus, RefreshCw, Trash, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_ALLOWLIST } from "../allowlist";
import * as cu from "../clickup";
import * as db from "../db";
import type { Check } from "../diag";
import * as git from "../git";
import * as lock from "../lock";
import * as mp from "../modelpick";
import * as runs from "../runs";
import * as settingsio from "../settingsio";
import * as updater from "../updater";
import { ProjectMark } from "../app/ProjectSwitcher";
import { resetCachedUser, settingsSignal, useAsync, useProjects, useSetting } from "../app/store";
import { applyTheme, type ThemePref } from "../app/theme";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Input, Textarea } from "../ui/input";
import { Segmented } from "../ui/segmented";
import { Switch } from "../ui/switch";
import { useToast } from "../ui/toast";

const SECTIONS = [
  { id: "diag", label: "Diagnostic" },
  { id: "clickup", label: "ClickUp" },
  { id: "pc", label: "Ce PC" },
  { id: "agent", label: "Agent et statuts" },
  { id: "models", label: "Modèles" },
  { id: "queue", label: "File d'attente" },
  { id: "projects", label: "Projets" },
  { id: "share", label: "Partage" },
  { id: "update", label: "Mises à jour" },
];

export function SettingsPage({ checks, onRecheck, update }: { checks: Check[] | null; onRecheck(): void; update: updater.UpdateInfo | null }) {
  const [active, setActive] = useState("diag");
  useEffect(() => {
    const box = document.getElementById("settings-scroll");
    if (!box) return;
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive(top.target.id);
    }, { root: box, rootMargin: "0px 0px -70% 0px" });
    for (const s of SECTIONS) { const el = document.getElementById(s.id); if (el) io.observe(el); }
    return () => io.disconnect();
  }, []);

  return (
    <div className="flex h-full">
      <nav className="hidden w-[220px] shrink-0 border-r border-border px-3 pt-6 md:block">
        <h1 className="mb-3 px-2 text-[20px] font-semibold tracking-tight">Réglages</h1>
        {SECTIONS.map((s) => (
          <a
            key={s.id} href={`#${s.id}`}
            onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
            className={cn("flex h-8 items-center gap-2 rounded-md px-2 text-[13.5px] text-muted-foreground hover:bg-muted hover:text-foreground", active === s.id && "bg-muted font-medium text-foreground")}
          >
            {s.label}
            {s.id === "diag" && checks?.some((c) => !c.ok) && <span className="ml-auto size-1.5 rounded-full bg-err" />}
            {s.id === "update" && update?.available && <span className="ml-auto size-1.5 rounded-full bg-brand" />}
          </a>
        ))}
      </nav>
      <div id="settings-scroll" className="min-w-0 flex-1 overflow-y-auto scroll-smooth">
        <div className="mx-auto grid max-w-[820px] gap-5 px-6 py-6 pb-24">
          <Diag checks={checks} onRecheck={onRecheck} />
          <ClickUp />
          <ThisPc />
          <Agent />
          <Models />
          <QueueSettings />
          <Projects />
          <Share />
          <Update initial={update} />
        </div>
      </div>
    </div>
  );
}

function Card({ id, title, description, action, children }: { id: string; title: string; description?: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-2xl border border-border bg-card">
      <header className="flex items-start gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>}
        </div>
        {action}
      </header>
      {children && <div className="px-5 pb-5">{children}</div>}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid items-center gap-2 border-t border-border py-3 first:border-t-0 first:pt-0 sm:grid-cols-[220px_minmax(0,1fr)]">
      <div>
        <div className="text-[13.5px] font-medium">{label}</div>
        {hint && <div className="text-[12px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const selectCls = "h-[34px] w-full rounded-md border border-border bg-card px-2 text-[13.5px] shadow-xs outline-none focus:border-border-strong";

function Status({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-[12.5px]", ok === null ? "text-muted-foreground" : ok ? "text-ok-fg" : "text-err-fg")}>
      {ok === true && <CircleCheck className="mt-px size-3.5 shrink-0" />}
      {ok === false && <CircleAlert className="mt-px size-3.5 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

// ---------- sections ----------

function Diag({ checks, onRecheck }: { checks: Check[] | null; onRecheck(): void }) {
  return (
    <Card id="diag" title="Diagnostic de ce PC" description="Outils dont Codbot a besoin pour lancer les agents." action={<Button variant="outline" size="sm" onClick={onRecheck}><RefreshCw />Revérifier</Button>}>
      <ul className="grid gap-1.5">
        {!checks && <li className="text-[13px] text-muted-foreground">Vérification…</li>}
        {checks?.map((c) => (
          <li key={c.name} className="flex items-start gap-2.5 rounded-lg px-1 py-1 text-[13px]">
            {c.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-err" />}
            <span className="font-medium">{c.name}</span>
            <span className={cn("min-w-0 flex-1", c.ok ? "text-muted-foreground" : "text-err-fg")}>{c.detail}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ClickUp() {
  const toast = useToast();
  const [token, setToken] = useState("");
  const [tick, setTick] = useState(0);
  const me = useAsync(async () => ((await cu.getToken()) ? cu.getUser() : null), [tick], null);
  const teams = useAsync(async () => (me.data ? cu.getTeams() : []), [me.data], []);
  const [teamId, setTeamId] = useSetting<string>("team_id", "");
  useEffect(() => {
    if (!teamId && teams.data.length) void setTeamId(teams.data[0].id);
  }, [teamId, teams.data, setTeamId]);

  return (
    <Card id="clickup" title="ClickUp" description="Jeton API : ClickUp → Réglages → Apps → API Token. Stocké dans le Gestionnaire d'identification Windows, jamais en clair.">
      <Row label="Jeton API" hint={me.loading ? "Vérification…" : undefined}>
        <div className="flex gap-2">
          <Input type="password" placeholder="pk_…" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Jeton API ClickUp" />
          <Button disabled={!token.trim()} onClick={async () => { await cu.setToken(token.trim()); resetCachedUser(); setToken(""); setTick((t) => t + 1); toast("Jeton enregistré"); }}>Enregistrer</Button>
          <Button variant="ghost" onClick={async () => { await cu.clearToken(); resetCachedUser(); setTick((t) => t + 1); }}>Supprimer</Button>
        </div>
        <div className="mt-2">
          {me.error ? <Status ok={false}>{me.error}</Status>
            : me.data ? <Status ok>Connecté en tant que {me.data.username} ({me.data.email})</Status>
            : !me.loading && <Status ok={false}>Aucun jeton enregistré.</Status>}
        </div>
      </Row>
      <Row label="Espace de travail">
        <select className={selectCls} value={teamId} onChange={(e) => void setTeamId(e.target.value)} disabled={!teams.data.length}>
          {!teams.data.length && <option value="">—</option>}
          {teams.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Row>
    </Card>
  );
}

function ThisPc() {
  const toast = useToast();
  const current = useAsync(() => lock.pcName(), [], "");
  const [name, setName] = useState<string | null>(null);
  const value = name ?? current.data;
  return (
    <Card id="pc" title="Ce PC" description="Une tâche prise par ce PC reçoit un tag de verrou dans ClickUp ; les autres PC la laissent de côté jusqu'à la fin du run.">
      <Row label="Nom" hint={<>Tag : <code className="font-mono">{lock.lockTag(value || "pc")}</code></>}>
        <div className="flex gap-2">
          <Input value={value} onChange={(e) => setName(e.target.value)} aria-label="Nom de ce PC" />
          <Button disabled={name === null} onClick={async () => { await db.setSetting("pc_name", value.trim()); await lock.pcName(); setName(null); current.reload(); toast("Nom enregistré"); }}>Enregistrer</Button>
        </div>
      </Row>
    </Card>
  );
}

function Agent() {
  const [mode, setMode] = useSetting<db.StatusMode>("status_mode", "auto");
  const [theme, setTheme] = useSetting<ThemePref>("theme", "auto");
  return (
    <Card id="agent" title="Agent et statuts">
      <Row label="Statuts ClickUp" hint={mode === "auto" ? "Codbot change le statut et commente la tâche." : "Codbot propose, tu valides chaque changement."}>
        <Segmented<db.StatusMode> value={mode} onChange={(v) => void setMode(v)} label="Statuts" options={[{ value: "auto", label: "Automatiques" }, { value: "manual", label: "Je valide" }]} />
      </Row>
      <Row label="Apparence">
        <Segmented<ThemePref>
          value={theme} label="Thème"
          onChange={(v) => { void setTheme(v); void applyTheme(v); }}
          options={[{ value: "auto", label: "Comme Windows" }, { value: "light", label: "Clair" }, { value: "dark", label: "Sombre" }]}
        />
      </Row>
    </Card>
  );
}

const choiceKey = (c: mp.Choice) => `${c.model}:${c.effort}`;
const parseChoice = (v: string): mp.Choice => {
  const [model, effort] = v.split(":");
  return { model: model as mp.ModelId, effort: effort as mp.Effort };
};

/** Liste des couples modèle · effort autorisés ; une valeur hors autorisations reste affichée, signalée. */
function ChoiceSelect({ value, allowed, onChange, label }: { value: mp.Choice; allowed: mp.ModelPolicy["allowed"]; onChange(c: mp.Choice): void; label: string }) {
  const options = mp.MODELS.flatMap((m) => allowed[m.id].map((effort) => ({ model: m.id, effort })));
  const ok = allowed[value.model].includes(value.effort);
  const fallback = ok ? null : mp.clamp(value, allowed);
  return (
    <select
      className={cn(selectCls, "h-8 text-[12.5px]", !ok && "border-warn text-warn-fg")} value={choiceKey(value)} aria-label={label}
      onChange={(e) => onChange(parseChoice(e.target.value))}
      title={fallback ? `Non autorisé : ${mp.choiceLabel(fallback)} sera utilisé` : undefined}
    >
      {!ok && <option value={choiceKey(value)}>{mp.choiceLabel(value)} (non autorisé)</option>}
      {options.map((o) => <option key={choiceKey(o)} value={choiceKey(o)}>{mp.choiceLabel(o)}</option>)}
    </select>
  );
}

function Models() {
  const [raw, setRaw] = useSetting<unknown>("model_policy", null);
  const [legacy] = useSetting<string>("model", "");
  const policy = mp.normalizePolicy(raw, legacy);
  const save = (patch: Partial<mp.ModelPolicy>) => void setRaw({ ...policy, ...patch });
  const toggle = (model: mp.ModelId, effort: mp.Effort) => {
    const cur = policy.allowed[model];
    const next = cur.includes(effort) ? cur.filter((e) => e !== effort) : mp.EFFORTS.filter((e) => e === effort || cur.includes(e));
    save({ allowed: { ...policy.allowed, [model]: next } });
  };
  const setCell = (cat: mp.Category, size: mp.Size, c: mp.Choice) =>
    save({ matrix: { ...policy.matrix, [cat]: { ...policy.matrix[cat], [size]: c } } });
  const none = mp.MODELS.every((m) => !policy.allowed[m.id].length);
  const th = "px-2 py-1.5 text-left text-[12px] font-medium text-muted-foreground";
  return (
    <Card
      id="models" title="Modèles et raisonnement"
      description={<>Chaque run reçoit un modèle et un niveau d'effort. Les tags ClickUp <code className="font-mono">modele:opus</code>, <code className="font-mono">effort:high</code> ou <code className="font-mono">taille:grande</code> forcent le choix pour une tâche.</>}
    >
      <Row label="Choix du modèle" hint={policy.mode === "auto" ? "Selon la matrice ci-dessous." : policy.mode === "fixed" ? "Le même pour tous les runs." : "Codbot ne passe ni modèle ni effort."}>
        <Segmented<mp.ModelPolicy["mode"]>
          value={policy.mode} onChange={(mode) => save({ mode })} label="Choix du modèle"
          options={[{ value: "auto", label: "Automatique" }, { value: "fixed", label: "Fixe" }, { value: "default", label: "Défaut Claude Code" }]}
        />
      </Row>
      {policy.mode === "fixed" && (
        <Row label="Modèle fixe">
          <ChoiceSelect value={policy.fixed} allowed={policy.allowed} onChange={(fixed) => save({ fixed })} label="Modèle fixe" />
        </Row>
      )}
      {policy.mode === "auto" && (
        <Row label="Classement des tâches" hint={policy.triage === "ai" ? "Haiku lit la tâche (quelques secondes, repli sur les règles)." : "Mots-clés, tags, longueur et sous-éléments."}>
          <Segmented<mp.ModelPolicy["triage"]>
            value={policy.triage} onChange={(triage) => save({ triage })} label="Classement"
            options={[{ value: "rules", label: "Règles locales" }, { value: "ai", label: "IA (Haiku)" }]}
          />
        </Row>
      )}
      {policy.mode !== "default" && (
        <div className="border-t border-border py-3">
          <div className="text-[13.5px] font-medium">Autorisés</div>
          <div className="mb-2 text-[12px] text-muted-foreground">Efforts que chaque modèle peut recevoir. Un choix hors liste est ramené au plus proche autorisé.</div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr><th className={th}>Modèle</th>{mp.EFFORTS.map((e) => <th key={e} className={cn(th, "text-center")}>{mp.EFFORT_LABELS[e]}</th>)}</tr></thead>
              <tbody>
                {mp.MODELS.map((m) => (
                  <tr key={m.id} className="border-t border-border">
                    <td className="px-2 py-1.5 text-[13px]"><span className="font-medium">{m.label}</span> <span className="text-[12px] text-muted-foreground">{m.hint}</span></td>
                    {mp.EFFORTS.map((e) => {
                      const on = policy.allowed[m.id].includes(e);
                      return (
                        <td key={e} className="px-1 py-1 text-center">
                          <button
                            type="button" aria-pressed={on} aria-label={`${m.label} ${mp.EFFORT_LABELS[e]}`} onClick={() => toggle(m.id, e)}
                            className={cn("h-7 w-full min-w-12 cursor-pointer rounded-md border text-[12px]", on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-muted")}
                          >
                            {on ? "Oui" : "—"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {none && <div className="mt-2"><Status ok={false}>Aucun modèle autorisé : les runs utiliseront le modèle par défaut de Claude Code.</Status></div>}
        </div>
      )}
      {policy.mode === "auto" && (
        <div className="border-t border-border pt-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">Matrice tâche → modèle</div>
              <div className="mb-2 text-[12px] text-muted-foreground">Type de tâche × taille estimée. Sert aussi de grille au classement par IA.</div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => save({ matrix: mp.DEFAULT_MATRIX })}>Réinitialiser</Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead><tr><th className={th}>Tâche</th>{mp.SIZES.map((s) => <th key={s.id} className={th}>{s.label}</th>)}</tr></thead>
              <tbody>
                {mp.CATEGORIES.map((cat) => (
                  <tr key={cat.id} className="border-t border-border">
                    <td className="px-2 py-1.5 align-top"><div className="text-[13px] font-medium">{cat.label}</div><div className="text-[11.5px] text-muted-foreground">{cat.hint}</div></td>
                    {mp.SIZES.map((s) => (
                      <td key={s.id} className="min-w-[150px] px-1 py-1.5 align-top">
                        <ChoiceSelect value={policy.matrix[cat.id][s.id]} allowed={policy.allowed} onChange={(c) => setCell(cat.id, s.id, c)} label={`${cat.label}, ${s.label}`} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

function QueueSettings() {
  const [concurrency, setConcurrency] = useSetting<number>("concurrency", 2);
  const [timeout, setTimeout_] = useSetting<number>("question_timeout_min", 10);
  const [unattended, setUnattended] = useSetting<boolean>("unattended", false);
  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Number(v) || min));
  return (
    <Card id="queue" title="File d'attente" description="Sans réponse dans le délai, un run de la file passe en « Bloqué » et la file continue. Sur limite d'usage, la file attend la réinitialisation puis reprend.">
      <Row label="Agents en parallèle" hint="Aussi le nombre d'emplacements du dock.">
        <div className="flex items-center gap-1.5">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button key={n} type="button" onClick={() => void setConcurrency(n)} aria-pressed={concurrency === n}
              className={cn("grid size-[34px] cursor-pointer place-items-center rounded-md border text-[13.5px] font-medium", concurrency === n ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted")}>{n}</button>
          ))}
        </div>
      </Row>
      <Row label="Délai de réponse" hint="En minutes, pour les runs de la file.">
        <Input type="number" min={1} max={240} defaultValue={timeout} key={timeout} className="w-28" onBlur={(e) => void setTimeout_(num(e.target.value, 1, 240))} aria-label="Délai de réponse en minutes" />
      </Row>
      <Row label="Sans surveillance" hint="Les permissions sont décidées par la liste blanche de chaque projet.">
        <Switch checked={unattended} onCheckedChange={(v) => void setUnattended(v)} label="Mode sans surveillance" />
      </Row>
    </Card>
  );
}

// ---------- projets ----------

function Projects() {
  const projects = useProjects();
  return (
    <Card id="projects" title="Projets" description="Chaque projet relie une liste ClickUp à un repo local.">
      <div className="grid gap-3">
        {projects.data.map((p) => <ProjectBlock key={p.list_id} project={p} />)}
        {!projects.data.length && !projects.loading && <p className="text-[13px] text-muted-foreground">Aucun projet. Ajoute une liste ClickUp et le repo qui lui correspond.</p>}
        <AddProject />
      </div>
    </Card>
  );
}

function ProjectBlock({ project: p }: { project: db.Project }) {
  const toast = useToast();
  const [open, setOpen] = useState(!p.repo_path);
  const [repo, setRepo] = useState(p.repo_path);
  const [base, setBase] = useState(p.base_branch);
  const [verify, setVerify] = useState(p.verify_command ?? "");
  const [allow, setAllow] = useState(p.allowlist.join("\n"));
  const always = useAsync(() => runs.alwaysAllowList(p.list_id), [p.list_id], [] as string[]);
  const statuses = useAsync(async () => (open ? (await cu.getList(p.list_id)).statuses : []), [open, p.list_id], [] as cu.CuStatus[]);
  const mappings = useAsync(() => db.getMappings(p.list_id), [p.list_id], {} as Partial<Record<db.StatusEvent, string>>);
  const dirty = repo !== p.repo_path || base !== p.base_branch || verify !== (p.verify_command ?? "") || allow !== p.allowlist.join("\n");

  async function save() {
    try {
      await git.git(repo.trim(), "rev-parse", "--git-dir");
      await db.saveProject({
        ...p,
        repo_path: repo.trim(),
        base_branch: base.trim() || "main",
        verify_command: verify.trim() || null,
        allowlist: allow.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
      });
      settingsSignal.bump();
      toast("Projet enregistré", p.list_name);
    } catch (e) {
      toast("Enregistrement impossible", (e as Error).message, "err");
    }
  }

  return (
    <div className="rounded-xl border border-border">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-3 text-left" aria-expanded={open}>
        <ProjectMark name={p.list_name} listId={p.list_id} size={24} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold">{p.list_name}</span>
          <span className="block truncate font-mono text-[11.5px] text-muted-foreground">{p.repo_path || "repo local à renseigner sur ce PC"} · {p.base_branch}</span>
        </span>
        {!p.repo_path && <span className="rounded bg-warn/15 px-1.5 text-[11.5px] text-warn-fg">à configurer</span>}
      </button>
      {open && (
        <div className="border-t border-border px-3.5 pt-3 pb-3.5">
          <Row label="Repo local">
            <div className="flex gap-2">
              <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="C:\Code\mon-projet" className="font-mono" />
              <Button variant="outline" size="icon" aria-label="Choisir le dossier" onClick={async () => { const d = await pickFolder({ directory: true }); if (typeof d === "string") setRepo(d); }}><FolderOpen /></Button>
            </div>
          </Row>
          <Row label="Branche principale"><Input value={base} onChange={(e) => setBase(e.target.value)} className="w-40 font-mono" /></Row>
          <Row label="Vérification avant push" hint="Optionnel, ex. npm test."><Input value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="npm test" className="font-mono" /></Row>
          <Row label="Liste blanche" hint={<>Mode sans surveillance. « Bash(npm test*) », « WebFetch », « mcp__github__* ». Lecture et modifications du worktree toujours autorisées ; git push toujours refusé.</>}>
            <Textarea rows={6} value={allow} onChange={(e) => setAllow(e.target.value)} placeholder={DEFAULT_ALLOWLIST.join("\n")} className="font-mono text-[12px]" />
            <Button variant="ghost" size="sm" className="mt-1.5" onClick={() => setAllow(DEFAULT_ALLOWLIST.join("\n"))}>Remettre la liste par défaut</Button>
          </Row>
          <Row label="Toujours autorisé" hint="Retenu depuis « Toujours autoriser », même quand tu surveilles.">
            <div className="flex flex-wrap gap-1.5">
              {always.data.map((pat) => (
                <span key={pat} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-muted/50 pr-1 pl-2 font-mono text-[12px]">
                  {pat}
                  <button type="button" aria-label={`Retirer ${pat}`} className="grid size-5 cursor-pointer place-items-center rounded hover:bg-border" onClick={async () => { await runs.setAlwaysAllowList(p.list_id, always.data.filter((x) => x !== pat)); always.reload(); }}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {!always.data.length && <span className="text-[12.5px] text-muted-foreground">Rien pour l'instant.</span>}
            </div>
          </Row>
          <Row label="Correspondance des statuts" hint="Statut ClickUp appliqué à chaque étape du run.">
            <div className="grid gap-2">
              {db.STATUS_EVENTS.map(({ event, label }) => (
                <label key={event} className="grid grid-cols-[minmax(0,1fr)_180px] items-center gap-2 text-[12.5px]">
                  <span className="text-muted-foreground">{label}</span>
                  <select className={selectCls} value={mappings.data[event] ?? ""} onChange={async (e) => { await db.setMapping(p.list_id, event, e.target.value); mappings.reload(); }}>
                    <option value="">(ne rien changer)</option>
                    {statuses.data.map((s) => <option key={s.status} value={s.status}>{s.status}</option>)}
                  </select>
                </label>
              ))}
              {statuses.error && <Status ok={false}>{statuses.error}</Status>}
            </div>
          </Row>
          <div className="mt-2 flex items-center gap-2 border-t border-border pt-3">
            <Button variant="destructive" size="sm" onClick={async () => { await db.deleteProject(p.list_id); settingsSignal.bump(); }}><Trash />Retirer le projet</Button>
            <span className="flex-1" />
            <Button disabled={!dirty} onClick={() => void save()}>Enregistrer</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddProject() {
  const toast = useToast();
  const [teamId] = useSetting<string>("team_id", "");
  const [space, setSpace] = useState("");
  const [listId, setListId] = useState("");
  const [repo, setRepo] = useState("");
  const [base, setBase] = useState("main");
  const [open, setOpen] = useState(false);
  const spaces = useAsync(async () => (open && teamId ? cu.getSpaces(teamId) : []), [open, teamId], [] as { id: string; name: string }[]);
  const lists = useAsync(async () => {
    if (!space) return [] as { group: string; lists: { id: string; name: string }[] }[];
    const [folders, loose] = await Promise.all([cu.getFolders(space), cu.getFolderlessLists(space)]);
    return [{ group: "", lists: loose }, ...folders.map((f) => ({ group: f.name, lists: f.lists }))];
  }, [space], []);
  const listName = lists.data.flatMap((g) => g.lists).find((l) => l.id === listId)?.name ?? listId;

  async function add() {
    try {
      await git.git(repo.trim(), "rev-parse", "--git-dir");
      if (!(await git.hasRemote(repo.trim()))) throw new Error("Ce repo n'a pas de remote « origin ».");
      await db.saveProject({ list_id: listId, list_name: listName, repo_path: repo.trim(), base_branch: base.trim() || "main", verify_command: null, allowlist: DEFAULT_ALLOWLIST });
      settingsSignal.bump();
      toast("Projet ajouté", listName);
      setOpen(false); setSpace(""); setListId(""); setRepo(""); setBase("main");
    } catch (e) {
      toast("Ajout impossible", (e as Error).message, "err");
    }
  }

  if (!open) return <Button variant="outline" className="justify-self-start" onClick={() => setOpen(true)} disabled={!teamId}><Plus />Ajouter un projet</Button>;
  return (
    <div className="pop-in rounded-xl border border-dashed border-border-strong p-3.5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-[12.5px] font-medium text-muted-foreground">Espace
          <select className={selectCls} value={space} onChange={(e) => { setSpace(e.target.value); setListId(""); }}>
            <option value="">{spaces.loading ? "Chargement…" : "Choisir…"}</option>
            {spaces.data.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-[12.5px] font-medium text-muted-foreground">Liste
          <select className={selectCls} value={listId} onChange={(e) => setListId(e.target.value)} disabled={!space}>
            <option value="">Choisir…</option>
            {lists.data.map((g) => g.group
              ? <optgroup key={g.group} label={g.group}>{g.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>
              : g.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>))}
          </select>
        </label>
        <label className="grid gap-1.5 text-[12.5px] font-medium text-muted-foreground">Repo local
          <div className="flex gap-2">
            <Input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="C:\Code\mon-projet" className="font-mono" />
            <Button variant="outline" size="icon" aria-label="Choisir le dossier" onClick={async () => { const d = await pickFolder({ directory: true }); if (typeof d === "string") setRepo(d); }}><FolderOpen /></Button>
          </div>
        </label>
        <label className="grid gap-1.5 text-[12.5px] font-medium text-muted-foreground">Branche principale
          <Input value={base} onChange={(e) => setBase(e.target.value)} className="font-mono" />
        </label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
        <Button variant="brand" disabled={!listId || !repo.trim()} onClick={() => void add()}><Plus />Ajouter</Button>
      </div>
    </div>
  );
}

// ---------- partage et mises à jour ----------

function Share() {
  const toast = useToast();
  return (
    <Card
      id="share" title="Partager les réglages entre PC"
      description="L'export contient l'espace de travail, les statuts, le modèle, la file, les projets et leurs correspondances. Ni le jeton ClickUp ni les chemins des repos : chaque PC garde les siens."
    >
      <div className="flex gap-2">
        <Button variant="outline" onClick={async () => {
          try { const path = await settingsio.exportToFile(); if (path) toast("Réglages exportés", String(path)); } catch (e) { toast("Export impossible", (e as Error).message, "err"); }
        }}><Download />Exporter…</Button>
        <Button variant="outline" onClick={async () => {
          try {
            const r = await settingsio.importFromFile();
            if (!r) return;
            settingsSignal.bump();
            toast("Réglages importés", `${r.projects} projet(s)${r.toConfigure ? ` · ${r.toConfigure} repo(s) à renseigner` : ""}`);
          } catch (e) { toast("Import impossible", (e as Error).message, "err"); }
        }}><Upload />Importer…</Button>
      </div>
    </Card>
  );
}

function Update({ initial }: { initial: updater.UpdateInfo | null }) {
  const [info, setInfo] = useState<updater.UpdateInfo | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  useEffect(() => setInfo(initial), [initial]);
  async function check() {
    setError(null);
    try { setInfo(await updater.checkForUpdate()); } catch (e) { setError(`Vérification impossible : ${(e as Error).message ?? e}`); }
  }
  const up = info?.available;
  return (
    <Card id="update" title="Version et mises à jour" description="Publiées dans les releases GitHub de Codbot et signées : une version non signée est refusée." action={<Button variant="outline" size="sm" onClick={() => void check()}><RefreshCw />Vérifier</Button>}>
      {error ? <Status ok={false}>{error}</Status>
        : !info ? <Status ok={null}>Vérification…</Status>
        : !up ? <Status ok>Version {info.current} : à jour.</Status>
        : (
          <div className="grid gap-3">
            <Status ok={null}>Version {info.current} installée, <b className="text-foreground">{up.version}</b> disponible.</Status>
            {up.body && <p className="rounded-lg bg-muted/60 px-3 py-2 text-[12.5px] whitespace-pre-wrap">{up.body}</p>}
            <Button variant="brand" className="justify-self-start" disabled={progress !== null}
              onClick={() => {
                setProgress("…");
                void updater.installAndRelaunch(up, (pct) => setProgress(pct === null ? "…" : `${pct} %`))
                  .catch((e) => { setProgress(null); setError(`Installation impossible : ${(e as Error).message ?? e}`); });
              }}>
              <Download />{progress !== null ? `Téléchargement ${progress}` : "Installer et redémarrer"}
            </Button>
          </div>
        )}
    </Card>
  );
}
