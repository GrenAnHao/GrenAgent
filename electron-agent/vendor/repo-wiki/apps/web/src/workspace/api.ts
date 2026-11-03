export const API = "/api/workspace";
export type SourceRef = {
  path: string;
  start_line: number;
  end_line: number;
  hash?: string;
};
export type WikiPage = {
  id: string;
  title: string;
  markdown: string;
  baseline?: string;
  pending_markdown?: string | null;
  status: string;
  revision: number;
  storage_token?: string;
  sources: SourceRef[];
  dependencies?: string[];
  fingerprint?: string;
  updated_at?: string | null;
  kind?: "page" | "wiki" | "card";
  category?: string;
  summary?: string;
  inputManifest?: { engine?: string; nativePublicationId?: string };
  native_section?: { parentId?: string; ordinal?: number; sectionName?: string };
  identity?: Record<string, any>;
  coverage?: {
    partial?: boolean;
    provided_files?: number;
    available_files?: number;
    omitted_files?: string[];
    truncated_files?: string[];
  };
};
export type Project = {
  id: string;
  name: string;
  path: string;
  language: string;
  watch: boolean;
  plan?: Record<string, unknown>;
  plan_storage_token?: string;
  identity?: Record<string, any>;
  pages?: WikiPage[];
  cards?: WikiPage[];
  page_count?: number;
  native_catalogue?: Array<{ id: string; parentId?: string; ordinal?: number; sectionName?: string; title?: string }>;
  card_count?: number;
  knowledge?: Partial<
    Record<
      "wiki" | "cards",
      {
        count: number;
        identity?: Record<string, any>;
        last_run?: Record<string, any> | null;
        updated_at?: string | null;
        engine?: string;
        native_publication_id?: string;
        native_coverage?: { partial: boolean; published: number; readable: number; failed: string[] };
      }
    >
  >;
  runs_by_kind?: Partial<Record<"wiki" | "cards", Run>>;
  stats?: Record<string, any>;
  last_run?: Record<string, any> | null;
  watch_status_by_kind?: Partial<
    Record<"wiki" | "cards", { status: string; message: string }>
  >;
  watch_status?: { status: string; message: string };
};
export type Run = {
  id?: string;
  status: string;
  provider?: string;
  target?: "wiki" | "cards";
  identity?: Record<string, any>;
  cancelable?: boolean;
  stage?: string;
  page_id?: string;
  current_page?: string;
  progress?: number;
  message?: string;
  events?: unknown[];
  result?: Record<string, any>;
  error?: string;
};
export type Changes = {
  changed?: string[];
  added?: string[];
  deleted?: string[];
  renamed?: unknown[];
  affected_pages?: string[];
  identity?: Record<string, any>;
};
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(API + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(method !== "GET" ? { "X-RepoWiki-Request": "1" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      typeof error.detail === "string"
        ? error.detail
        : error.message || `请求失败 (${response.status})`,
    );
  }
  return response.json();
}
export function pageUrl(project: string, page: string) {
  return `/projects/${encodeURIComponent(project)}/pages/${page.split("/").map(encodeURIComponent).join("/")}`;
}

export type { RepoWikiClient } from "../../../../packages/contracts/src/index";
import type { RepoWikiClient } from "../../../../packages/contracts/src/index";
import { routeRequest } from "../../../../packages/contracts/src/index";
import {
  createGrenRepoWikiClient,
  type GrenRuntimeBridge,
} from "../../../../packages/renderer/src/index";
import { zipSync, strToU8 } from "fflate";
declare global {
  interface Window {
    repoWiki?: RepoWikiClient;
  }
}
export function runtimeClient(): RepoWikiClient | undefined {
  const gren = (window as unknown as { gren?: GrenRuntimeBridge }).gren;
  return (
    window.repoWiki ??
    (gren ? createGrenRepoWikiClient(gren) : undefined)
  );
}
export async function requestViaClient<T>(
  client: RepoWikiClient,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const route = routeRequest(method, path, body);
  return (await client.invoke(route.action, route.input)) as T;
}
export async function downloadMarkdown(
  projectId: string,
  client?: RepoWikiClient,
  target: "wiki" | "cards" = "wiki",
) {
  let blob: Blob;
  if (client) {
    const documents = await client.invoke("export", {
      project_id: projectId,
      target,
    });
    const files: Record<string, Uint8Array> = Object.create(null);
    for (const [path, text] of Object.entries(documents)) {
      if (
        !path ||
        /[\\:\x00-\x1f]/.test(path) ||
        path.startsWith("/") ||
        path.split("/").some((p) => !p || p === "." || p === "..")
      )
        throw new Error("Unsafe export path");
      files[path] = strToU8(text);
    }
    blob = new Blob([zipSync(files) as BlobPart], { type: "application/zip" });
  } else {
    const response = await fetch(
      `${API}/projects/${encodeURIComponent(projectId)}/export?target=${target}`,
    );
    if (!response.ok) throw new Error("导出失败");
    blob = await response.blob();
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `repowiki-${projectId}-${target}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
