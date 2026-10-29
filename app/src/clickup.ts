// Client ClickUp (REST v2) via le plugin http : les appels partent du cœur Rust, sans CORS.
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";

const API = "https://api.clickup.com/api/v2";
export const TOKEN_KEY = "clickup-token";

export type CuStatus = { status: string; color: string; type: string; orderindex: number };
export type CuUser = { id: number; username: string; email: string };
export type CuTask = {
  id: string;
  custom_id: string | null;
  name: string;
  description?: string;
  markdown_description?: string;
  text_content?: string;
  status: { status: string; color: string; type: string };
  assignees: CuUser[];
  tags: { name: string }[];
  url: string;
  parent: string | null;
  list: { id: string; name: string };
  subtasks?: CuTask[];
  checklists?: { name: string; items: { name: string; resolved: boolean }[] }[];
  due_date: string | null;
};

let cachedToken: string | null = null;

export async function getToken() {
  cachedToken ??= await invoke<string | null>("secret_get", { key: TOKEN_KEY });
  return cachedToken;
}

export async function setToken(token: string) {
  await invoke("secret_set", { key: TOKEN_KEY, value: token });
  cachedToken = token;
}

export async function clearToken() {
  await invoke("secret_delete", { key: TOKEN_KEY });
  cachedToken = null;
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("Jeton ClickUp manquant : renseigne-le dans les Réglages.");
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickUp ${res.status} sur ${path} : ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export const getUser = () => api<{ user: CuUser }>("/user").then((r) => r.user);
export const getTeams = () => api<{ teams: { id: string; name: string }[] }>("/team").then((r) => r.teams);
export const getSpaces = (teamId: string) =>
  api<{ spaces: { id: string; name: string }[] }>(`/team/${teamId}/space?archived=false`).then((r) => r.spaces);
export const getFolders = (spaceId: string) =>
  api<{ folders: { id: string; name: string; lists: { id: string; name: string }[] }[] }>(
    `/space/${spaceId}/folder?archived=false`,
  ).then((r) => r.folders);
export const getFolderlessLists = (spaceId: string) =>
  api<{ lists: { id: string; name: string }[] }>(`/space/${spaceId}/list?archived=false`).then((r) => r.lists);
export const getList = (listId: string) =>
  api<{ id: string; name: string; statuses: CuStatus[] }>(`/list/${listId}`);

/** Toutes les tâches ouvertes d'une liste, sous-tâches comprises (pagination de 100). */
export async function getListTasks(listId: string, includeClosed = false) {
  const tasks: CuTask[] = [];
  for (let page = 0; page < 20; page++) {
    const r = await api<{ tasks: CuTask[]; last_page?: boolean }>(
      `/list/${listId}/task?subtasks=true&include_closed=${includeClosed}&page=${page}`,
    );
    tasks.push(...r.tasks);
    if (r.last_page !== false || r.tasks.length < 100) break;
  }
  return tasks;
}

export const getTask = (taskId: string) =>
  api<CuTask>(`/task/${taskId}?include_subtasks=true&include_markdown_description=true`);

export const setTaskStatus = (taskId: string, status: string) =>
  api<CuTask>(`/task/${taskId}`, { method: "PUT", body: { status } });

export const addComment = (taskId: string, text: string) =>
  api(`/task/${taskId}/comment`, { method: "POST", body: { comment_text: text, notify_all: false } });
