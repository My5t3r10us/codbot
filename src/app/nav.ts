import { createContext, useContext } from "react";

export type Page = "projects" | "tasks" | "agents" | "settings";
export type Nav = {
  page: Page;
  go(page: Page): void;
  /** Ouvre la page Agents sur la session d'un run. */
  openRun(runId: string): void;
  /** Ouvre l'arbre de décision d'un run qui attend l'utilisateur. */
  openDecision(runId?: string): void;
};

export const NavContext = createContext<Nav>({ page: "tasks", go() {}, openRun() {}, openDecision() {} });
export const useNav = () => useContext(NavContext);
