import * as runs from "../runs";
import { Button } from "../ui/button";
import { useRunsVersion } from "./store";

/** Mode manuel des statuts : Codbot propose, l'utilisateur valide. */
export function Suggestions() {
  useRunsVersion();
  const list = [...runs.suggestions.values()];
  if (!list.length) return null;
  return (
    <div className="flex flex-col gap-1.5 border-b border-border bg-card px-5 py-2">
      {list.map((s) => (
        <div key={s.id} className="fade-up flex flex-wrap items-center gap-2 text-[13px]">
          <span className="ldot text-warn" />
          <span className="min-w-0 flex-1">
            « {s.taskName} » : {s.status ? `passer en « ${s.status} »` : ""}
            {s.status && s.comment ? " et " : ""}
            {s.comment ? "ajouter le commentaire du run" : ""} ?
          </span>
          <Button size="sm" onClick={() => void runs.acceptSuggestion(s.id)}>Oui</Button>
          <Button size="sm" variant="ghost" onClick={() => runs.dismissSuggestion(s.id)}>Ignorer</Button>
        </div>
      ))}
    </div>
  );
}
