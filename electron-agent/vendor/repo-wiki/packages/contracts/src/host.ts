/** Renderer-safe host integration DTOs. Host display identities are not Wiki DB ids. */
import type { Project } from './index.js';

export interface HostProjectSummary {
  key: string;
  path: string;
  name: string;
}

export interface HostProjectsSnapshot {
  revision: number;
  state: 'pending' | 'ready' | 'error';
  projects: HostProjectSummary[];
  error?: string;
}

export interface HostActivationRequest {
  workspace: string | null;
  /** Stable for one mounted host view; a new view owns a distinct context even at the same path. */
  view_id?: string;
  language?: string;
  retry?: true;
}

export interface HostActivation {
  workspace: string | null;
  language: string;
  project_id: string | null;
  /** bound authorizes preparation, not repository access; hydrate checks host authority. */
  status: 'bound' | 'pending' | 'empty';
  context_id: string;
  projects_revision: number;
}

export interface HostHydrateRequest {
  __repoWikiContext: string;
}

export interface HostHydrateResult {
  context_id: string;
  project: Project;
}

export interface HostReleaseResult { released: boolean }

export interface HostRequestMap {
  repoWiki_activate: HostActivationRequest;
  repoWiki_hostProjects: Record<string, never>;
  repoWiki_hydrate: HostHydrateRequest;
  repoWiki_release: HostHydrateRequest;
}

export interface HostResponseMap {
  repoWiki_activate: HostActivation;
  repoWiki_hostProjects: HostProjectsSnapshot;
  repoWiki_hydrate: HostHydrateResult;
  repoWiki_release: HostReleaseResult;
}
